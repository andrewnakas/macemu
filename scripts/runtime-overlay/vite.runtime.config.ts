// Vite config for the macemu runtime bundle (runtime/entry.ts -> public/mac/).
//
//   vendor/infinite-mac$ node_modules/.bin/vite build --config vite.runtime.config.ts
//   (or: scripts/build-mac-runtime.sh from the repo root)
//
// Output (all names fixed, no content hashes -- the HTML references them by
// name with a ?v= query):
//
//   mac-runtime.js               IIFE defining window.MacEmulator
//   worker.js                    emulator web worker (ES module)
//   BasiliskII.js / SheepShaver.js / minivmac-<model>.js
//                                Emscripten glue, one chunk per emulator,
//                                loaded on demand by worker.js
//   *.wasm                       the emulator binaries
//   emulator-service-worker.js   service worker (fallback input + chunk cache)
//   emulator-audio-worklet.js    AudioWorklet processor
//
// ROMs are NOT emitted: every `import x from "*.rom"` (and the .hda device
// image headers) resolves to the string "/rom/<file>", which the site serves
// from R2 via a Pages Function. The runtime rewrites that prefix again at
// create() time from options.romBaseUrl.
import {defineConfig, type Plugin} from "vite";
import path from "node:path";
import fs from "node:fs";
import {execSync} from "node:child_process";

const root = __dirname;
const src = path.resolve(root, "src");
const runtime = path.resolve(root, "runtime");
const outDir = path.resolve(root, "../../public/mac");

const ROM_BASE_URL = process.env.MACEMU_ROM_BASE ?? "/rom";
const BASE = process.env.MACEMU_BASE ?? "/mac/";

function upstreamCommit(): string {
    try {
        return execSync("git rev-parse --short HEAD", {
            cwd: root,
            stdio: ["ignore", "pipe", "ignore"],
        })
            .toString()
            .trim();
    } catch {
        return "283d34c";
    }
}

/**
 * Turn ROM / device-image-header imports into URL strings under /rom/ instead
 * of emitting the binaries. Runs in both the page and worker bundles.
 */
function romUrlPlugin(): Plugin {
    return {
        name: "macemu-rom-urls",
        enforce: "pre",
        load(id) {
            const clean = id.split("?")[0];
            if (clean.endsWith(".rom") || clean.endsWith(".hda")) {
                const file = path.basename(clean);
                return `export default ${JSON.stringify(
                    `${ROM_BASE_URL}/${encodeURIComponent(file)}`
                )};`;
            }
            return null;
        },
    };
}

/**
 * Small source patches applied to vendored upstream files at build time (the
 * files on disk are never edited). The build fails loudly if the upstream
 * text is no longer exactly what the patch expects.
 *
 * src/emulator/ui/ui.ts (page bundle) -- two hard-codes made overridable;
 * runtime/entry.ts sets the globals before constructing the Emulator:
 *   - the service worker registration (URL + scope "/")
 *   - the chunk base URL "/Disk"
 *
 * src/emulator/worker/disk-saver.ts (worker bundle) -- opening a persistent
 * disk's OPFS sync-access handle retries for up to ~3 s. The page that was
 * just unloaded (a reload, or navigating to the next title) can still hold
 * the lock for a few hundred milliseconds while its worker is torn down, and
 * upstream gives up on the first NoModificationAllowedError, mounting the
 * disk without persistence.
 */
const UPSTREAM_PATCHES: {[file: string]: [string, string][]} = {
    "emulator/ui/ui.ts": [
        [
            `.register(serviceWorkerPath, {scope: "/", type: workerType})`,
            `.register((globalThis as any).__macemuServiceWorker?.url ?? serviceWorkerPath, {scope: (globalThis as any).__macemuServiceWorker?.scope ?? "/", type: workerType})`,
        ],
        [
            `baseUrl: "/Disk",`,
            `baseUrl: (globalThis as any).__macemuChunkBaseUrl ?? "/Disk",`,
        ],
    ],
    "emulator/worker/disk-saver.ts": [
        [
            `    for (const saver of savers) {
        try {
            await saver.init(opfsRoot);
        } catch (err) {
            console.warn("Could not init disk saver", err);`,
            `    for (const saver of savers) {
        let err: unknown = undefined;
        for (let attempt = 0; attempt < 15; attempt++) {
            try {
                await saver.init(opfsRoot);
                err = undefined;
                break;
            } catch (e) {
                err = e;
                // Release whichever handle did open before trying again.
                saver.close();
                if (String(e).includes("TypeError")) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        if (err !== undefined) {
            console.warn("Could not init disk saver", err);`,
        ],
    ],
};

function patchUpstreamPlugin(): Plugin {
    const byPath = new Map(
        Object.entries(UPSTREAM_PATCHES).map(([rel, patches]) => [
            path.resolve(src, rel),
            patches,
        ])
    );
    return {
        name: "macemu-patch-upstream",
        enforce: "pre",
        transform(code, id) {
            const patches = byPath.get(id.split("?")[0]);
            if (!patches) {
                return null;
            }
            for (const [from, to] of patches) {
                const count = code.split(from).length - 1;
                if (count !== 1) {
                    throw new Error(
                        `macemu-patch-upstream: expected exactly one occurrence of ${JSON.stringify(
                            from.slice(0, 80)
                        )} in ${id}, found ${count}. Upstream changed; update vite.runtime.config.ts.`
                    );
                }
                code = code.replace(from, to);
            }
            return {code, map: null};
        },
    };
}

/**
 * The Emscripten glue's default locateFile() does
 * `new URL("<emulator>.wasm", import.meta.url).href`. Vite treats that as an
 * asset reference and would emit (or inline) a second copy of every .wasm
 * from the worker bundle. The path is never used -- worker.ts passes the
 * already-fetched bytes through Module.instantiateWasm, which Emscripten
 * checks before calling findWasmBinary() -- so reduce it to the bare name.
 */
function emscriptenGluePlugin(): Plugin {
    const glueDir = path.resolve(src, "emulator/worker/emscripten") + path.sep;
    const pattern = /new URL\((['"])([^'"]+\.wasm)\1,\s*import\.meta\.url\)\.href/g;
    return {
        name: "macemu-emscripten-glue",
        enforce: "pre",
        transform(code, id) {
            const clean = id.split("?")[0];
            if (!clean.startsWith(glueDir) || !clean.endsWith(".js")) {
                return null;
            }
            let hits = 0;
            const out = code.replace(pattern, (_m, _q, file) => {
                hits++;
                return JSON.stringify(file);
            });
            if (hits === 0) {
                throw new Error(
                    `macemu-emscripten-glue: no wasm locateFile() reference found in ${clean}; upstream glue changed, update vite.runtime.config.ts`
                );
            }
            return {code: out, map: null};
        },
    };
}

function guardOutDir() {
    fs.mkdirSync(outDir, {recursive: true});
}

export default defineConfig(() => {
    guardOutDir();
    return {
        root,
        base: BASE,
        publicDir: false,
        resolve: {
            alias: [
                // Runtime replacements for upstream modules (must precede "@").
                {
                    find: "@/emulator/ui/emulators",
                    replacement: path.resolve(runtime, "ui-emulators.ts"),
                },
                {
                    find: "@/emulator/worker/emulators",
                    replacement: path.resolve(runtime, "worker-emulators.ts"),
                },
                {
                    find: "@/defs/device-image",
                    replacement: path.resolve(runtime, "device-image.ts"),
                },
                {
                    find: "@/defs/disks",
                    replacement: path.resolve(runtime, "disks.ts"),
                },
                {find: "@", replacement: src},
            ],
        },
        define: {
            __MACEMU_UPSTREAM_COMMIT__: JSON.stringify(upstreamCommit()),
        },
        plugins: [romUrlPlugin(), patchUpstreamPlugin()],
        worker: {
            format: "es" as const,
            plugins: () => [
                romUrlPlugin(),
                emscriptenGluePlugin(),
                patchUpstreamPlugin(),
            ],
            rolldownOptions: {
                output: {
                    entryFileNames: "[name].js",
                    chunkFileNames: "[name].js",
                    assetFileNames: "[name][extname]",
                },
            },
        },
        build: {
            outDir,
            emptyOutDir: false,
            assetsDir: "",
            // Small text assets (the macemu prefs templates) become data:
            // URLs; anything bigger is a real file. Deliberately NOT
            // build.lib: Vite inlines every asset in library mode, which would
            // base64 8 MB of wasm into mac-runtime.js.
            assetsInlineLimit: 4096,
            sourcemap: false,
            minify: true,
            modulePreload: false,
            chunkSizeWarningLimit: 4096,
            rolldownOptions: {
                input: path.resolve(runtime, "entry.ts"),
                // The entry installs window.MacEmulator itself; it has no
                // module exports for the IIFE wrapper to expose.
                output: {
                    format: "iife",
                    entryFileNames: "mac-runtime.js",
                    chunkFileNames: "[name].js",
                    assetFileNames: "[name][extname]",
                },
            },
        },
        clearScreen: false,
    };
});
