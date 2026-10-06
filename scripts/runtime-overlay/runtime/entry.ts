// macemu runtime entry: a framework-free wrapper around Infinite Mac's
// Emulator class (src/emulator/ui/ui.ts), built as an IIFE that defines the
// `MacEmulator` global. See vite.runtime.config.ts for how it is built and
// public/mac/NOTICE.md for licensing.
//
//   <script src="/mac/mac-runtime.js"></script>
//   <script>
//     const emu = MacEmulator.create({
//       parent: document.getElementById("stage"),
//       machine: "Quadra-650",
//       disks: ["system-7.5.3"],
//       screen: {width: 640, height: 480},
//       ramMB: 32,
//       onLoaded() {}, onProgress(done, total) {}, onError(message) {},
//     });
//     emu.pause(); emu.unpause(); emu.uploadFiles(fileList); emu.destroy();
//   </script>
import {
    Emulator,
    type EmulatorConfig,
    type EmulatorDelegate,
} from "@/emulator/ui/ui";
import {type MachineDef, type MachineDefRAMSize} from "@/defs/machines";
import type {EmulatorDiskDef} from "@/defs/disks";
import {
    type EmulatorCDROM,
    type EmulatorConfigFlags,
    type EmulatorDiskFile,
    type EmulatorMouseEvent,
    type EmulatorStatsUpdate,
    isDiskImageFile,
} from "@/emulator/common/common";
import {
    DEFAULT_EMULATOR_SETTINGS,
    type EmulatorSettings,
} from "@/emulator/ui/settings";
import type {EmbedControlEvent, EmbedNotificationEvent} from "@/embed-types";
import {findMachine, listMachines, type MachineInfo} from "./machines";

declare const __MACEMU_UPSTREAM_COMMIT__: string;

declare global {
    interface Window {
        /** Set to true once the emulator runtime has initialized (same moment
         *  the `emulator_loaded` message is posted). Used by the boot test. */
        __macBooted?: boolean;
        /** Set to the first fatal error message, if any. */
        __macBootError?: string;
    }
}

/** Where this bundle is served from ("/mac/"), fixed at build time. */
const BASE_URL: string = import.meta.env.BASE_URL;

/** Upstream infinite-mac commit this runtime was built from. */
const version: string = __MACEMU_UPSTREAM_COMMIT__;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The JSON written by scripts/chunk-disk.mjs (same fields as Infinite Mac's
 * import-disks.py, plus an optional prefetchChunks list).
 */
export type DiskManifest = {
    name: string;
    totalSize: number;
    chunks: string[];
    chunkSize: number;
    scrnResourceOffset?: number;
    prefetchChunks?: number[];
};

export type DiskSpec =
    | string
    | {
          /** Manifest name; loaded from `${diskManifestBaseUrl}${name}.json`
           *  unless `url` is given (a value containing "/" or ending in
           *  ".json" is used as a URL as-is). */
          name: string;
          url?: string;
          /** Chunk indices the service worker should fetch ahead of time.
           *  Defaults to the manifest's prefetchChunks, else [0]. */
          prefetchChunks?: number[];
          /** Persist writes to the origin private file system (Saved HD). */
          persistent?: boolean;
          isFloppy?: boolean;
          hasDeviceImageHeader?: boolean;
      };

export type DiskFileSpec =
    | File
    | {
          file: File;
          isCDROM?: boolean;
          isFloppy?: boolean;
          hasDeviceImageHeader?: boolean;
      };

export type EmulatorStats = EmulatorStatsUpdate;

export type MacEmulatorOptions = {
    /** Element the screen <canvas> is appended to. */
    parent: HTMLElement;
    /** Machine name, e.g. "Quadra-650", "Mac Plus", "Power Macintosh 9500".
     *  See MacEmulator.machines() for the list; matching ignores case and
     *  punctuation. */
    machine: string;
    /** Chunked disks to mount, in order. The first bootable one boots. */
    disks?: DiskSpec[];
    /** Local disk image files to mount at boot (File objects). */
    diskFiles?: DiskFileSpec[];
    /** CD-ROMs (Infinite Mac EmulatorCDROM records), passed through. */
    cdroms?: EmulatorCDROM[];
    /** Framebuffer size. Ignored for machines with a fixed screen (Mini vMac). */
    screen?: {width: number; height: number};
    /** RAM in megabytes; defaults to the machine's first ramSizes entry. */
    ramMB?: number;
    /** Force SharedArrayBuffer mode on/off. Defaults to auto-detection; true
     *  is downgraded to false (with a warning) when SAB is unavailable. */
    useSharedMemory?: boolean;
    /** Where ROMs are served from. Default "/rom" → "/rom/Quadra-650.rom". */
    romBaseUrl?: string;
    /** Where disk manifests live. Default "/mac/disks/". */
    diskManifestBaseUrl?: string;
    /** Where disk chunks are served from. Default "/Disk" → "/Disk/<hash>.chunk". */
    chunkBaseUrl?: string;
    /** Service worker script URL and scope. Default url "/mac/emulator-service-worker.js",
     *  scope = first path segment of the page ("/play/" for "/play/foo/"),
     *  which coexists with a site service worker registered at "/". The
     *  script lives under /mac/, so any scope outside /mac/ requires the
     *  response header `Service-Worker-Allowed: /` on the script URL. */
    serviceWorker?: {url?: string; scope?: string};
    /** Infinite Mac emulator settings (speed, swapControlAndCommand, ...). */
    settings?: Partial<EmulatorSettings>;
    /** Infinite Mac config flags (startPaused, autoPause, customDate, debugLog, ...). */
    flags?: EmulatorConfigFlags;
    /** CSS image-rendering: pixelated on the canvas. Default false (smooth). */
    pixelated?: boolean;
    /** Extra class name(s) for the canvas. */
    canvasClassName?: string;
    /** Start immediately (default true). Otherwise call handle.start(). */
    autoStart?: boolean;
    /** Accept Infinite Mac embed control messages (emulator_pause, ...) from
     *  window.parent and post emulator_loaded / emulator_screen back.
     *  Default: true when running inside an iframe. */
    embedMessages?: boolean;
    /** Post an `emulator_screen` message to the parent on every redraw. */
    screenUpdateMessages?: boolean;

    onLoaded?(handle: MacEmulatorHandle): void;
    onProgress?(done: number, total: number): void;
    onError?(message: string, raw?: string): void;
    onExit?(): void;
    onQuiescent?(): void;
    onScreenSize?(width: number, height: number): void;
    onDiskActivity?(active: boolean): void;
    onStats?(stats: EmulatorStats): void;
};

export type ExternalInputEvent =
    | EmulatorMouseEvent
    | {type: "keydown" | "keyup"; code: string};

export type MacEmulatorHandle = {
    readonly canvas: HTMLCanvasElement;
    readonly machine: MachineInfo;
    readonly useSharedMemory: boolean;
    /** The underlying Infinite Mac Emulator, for anything not wrapped here. */
    readonly emulator: Emulator;
    /** Resolves when the emulator runtime is initialized (onLoaded). */
    readonly ready: Promise<MacEmulatorHandle>;
    start(): Promise<void>;
    pause(): void;
    unpause(): void;
    /** Upload files into the emulated machine (Basilisk II / SheepShaver see
     *  them in the "Downloads" folder of the Unix disk; disk images are
     *  mounted instead). */
    uploadFiles(files: FileList | File[], names?: string[]): Promise<void>;
    loadCDROM(cdrom: EmulatorCDROM): Promise<void>;
    restart(): Promise<void>;
    sendInput(event: ExternalInputEvent): void;
    setSettings(settings: Partial<EmulatorSettings>): void;
    destroy(): void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sharedMemoryAvailable(): boolean {
    return typeof SharedArrayBuffer !== "undefined";
}

function machines(): MachineInfo[] {
    return listMachines();
}

function basename(path: string): string {
    return path.split("/").pop()!;
}

function stripTrailingSlash(s: string): string {
    return s.endsWith("/") ? s.slice(0, -1) : s;
}

function ensureTrailingSlash(s: string): string {
    return s.endsWith("/") ? s : s + "/";
}

function isPositiveInt(n: unknown): n is number {
    return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function defaultServiceWorkerScope(): string {
    const first = location.pathname.split("/")[1];
    return first ? `/${first}/` : "/";
}

async function fetchManifest(url: string): Promise<DiskManifest> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `Could not load disk manifest ${url} (HTTP ${response.status})`
        );
    }
    const manifest = (await response.json()) as DiskManifest;
    if (
        !manifest ||
        typeof manifest.name !== "string" ||
        !Array.isArray(manifest.chunks) ||
        !isPositiveInt(manifest.chunkSize) ||
        typeof manifest.totalSize !== "number"
    ) {
        throw new Error(`Disk manifest ${url} is malformed`);
    }
    return manifest;
}

function makeDiskDef(spec: DiskSpec, manifestBaseUrl: string): EmulatorDiskDef {
    const normalized = typeof spec === "string" ? {name: spec} : spec;
    if (!normalized || typeof normalized.name !== "string" || !normalized.name) {
        throw new Error("Each disk must be a manifest name or {name: string}");
    }
    let url = normalized.url;
    if (!url) {
        const {name} = normalized;
        url =
            name.includes("/") || name.endsWith(".json")
                ? name
                : `${manifestBaseUrl}${encodeURIComponent(name)}.json`;
    }
    const def: EmulatorDiskDef = {
        generatedSpec: async () => {
            const manifest = await fetchManifest(url!);
            // ui.ts reads def.prefetchChunks after generatedSpec() resolves,
            // so the manifest can supply the list when the caller did not.
            if (normalized.prefetchChunks) {
                def.prefetchChunks = normalized.prefetchChunks;
            } else if (Array.isArray(manifest.prefetchChunks)) {
                def.prefetchChunks = manifest.prefetchChunks;
            }
            return {default: manifest};
        },
        prefetchChunks: normalized.prefetchChunks ?? [0],
        persistent: normalized.persistent,
        isFloppy: normalized.isFloppy,
        hasDeviceImageHeader: normalized.hasDeviceImageHeader,
    };
    return def;
}

function makeDiskFile(spec: DiskFileSpec): EmulatorDiskFile {
    const normalized = spec instanceof File ? {file: spec} : spec;
    const {file} = normalized;
    if (!(file instanceof File)) {
        throw new Error("diskFiles entries must be File objects or {file: File}");
    }
    if (!isDiskImageFile(file)) {
        console.warn(
            `${file.name} does not look like a disk image (expected .dsk/.img/.iso/.hda/...), mounting anyway`
        );
    }
    const lower = file.name.toLowerCase();
    return {
        name: file.name,
        url: URL.createObjectURL(file),
        size: file.size,
        isCDROM:
            normalized.isCDROM ??
            (lower.endsWith(".iso") ||
                lower.endsWith(".toast") ||
                lower.endsWith(".cdr")),
        isFloppy: normalized.isFloppy,
        hasDeviceImageHeader: normalized.hasDeviceImageHeader,
    };
}

/** Rewrite the machine's bundled ROM paths to our /rom/ route. */
function machineForRuntime(machine: MachineDef, romBaseUrl: string): MachineDef {
    const base = stripTrailingSlash(romBaseUrl);
    const remapped: MachineDef = {
        ...machine,
        romPath: `${base}/${basename(machine.romPath)}`,
    };
    if (machine.extraFiles) {
        remapped.extraFiles = Object.fromEntries(
            Object.entries(machine.extraFiles).map(([fileName, url]) => [
                fileName,
                `${base}/${basename(url)}`,
            ])
        );
    }
    return remapped;
}

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

function create(options: MacEmulatorOptions): MacEmulatorHandle {
    if (!options || typeof options !== "object") {
        throw new Error("MacEmulator.create(options) requires an options object");
    }
    const {parent} = options;
    if (!(parent instanceof HTMLElement)) {
        throw new Error("MacEmulator.create: options.parent must be an HTMLElement");
    }
    if (typeof options.machine !== "string" || !options.machine) {
        throw new Error("MacEmulator.create: options.machine must be a machine name");
    }
    const machineDef = findMachine(options.machine);
    if (!machineDef) {
        throw new Error(
            `MacEmulator.create: unknown machine "${options.machine}". Known machines: ${listMachines()
                .map(m => m.name)
                .join(", ")}`
        );
    }
    const machine = machineForRuntime(machineDef, options.romBaseUrl ?? "/rom");
    const machineInfo = listMachines().find(m => m.name === machineDef.name)!;

    // Screen
    let screen = machine.fixedScreenSize ?? options.screen ?? {width: 640, height: 480};
    if (!isPositiveInt(screen.width) || !isPositiveInt(screen.height)) {
        throw new Error("MacEmulator.create: screen.width/height must be positive integers");
    }
    if (
        machine.fixedScreenSize &&
        options.screen &&
        (options.screen.width !== screen.width ||
            options.screen.height !== screen.height)
    ) {
        console.warn(
            `${machine.name} has a fixed ${screen.width}x${screen.height} screen; ignoring requested ${options.screen.width}x${options.screen.height}`
        );
    }

    // RAM
    let ramSize: MachineDefRAMSize | undefined;
    if (options.ramMB !== undefined) {
        if (!isPositiveInt(options.ramMB)) {
            throw new Error("MacEmulator.create: ramMB must be a positive integer");
        }
        ramSize = `${options.ramMB}M`;
        if (!machine.ramSizes.includes(ramSize)) {
            console.warn(
                `${machine.name}: ${ramSize} is not one of the tested RAM sizes (${machine.ramSizes.join(", ")}); using it anyway`
            );
        }
    }

    // Shared memory vs fallback
    const sabAvailable = sharedMemoryAvailable();
    let useSharedMemory = options.useSharedMemory ?? sabAvailable;
    if (useSharedMemory && !sabAvailable) {
        console.warn("SharedArrayBuffer is not available; using fallback mode");
        useSharedMemory = false;
    }
    if (!useSharedMemory) {
        console.warn(
            "MacEmulator: running in fallback (non-SharedArrayBuffer) mode. " +
                "Performance is reduced and a service worker is required for input. " +
                "Serve the page with Cross-Origin-Opener-Policy: same-origin and " +
                "Cross-Origin-Embedder-Policy: require-corp to enable shared memory."
        );
    }

    // Canvas
    const canvas = document.createElement("canvas");
    canvas.width = screen.width;
    canvas.height = screen.height;
    canvas.className = ["MacEmulator-screen", options.canvasClassName ?? ""]
        .join(" ")
        .trim();
    canvas.style.display = "block";
    canvas.style.maxWidth = "100%";
    canvas.style.height = "auto";
    canvas.style.touchAction = "none";
    if (options.pixelated) {
        canvas.style.imageRendering = "pixelated";
    }
    canvas.setAttribute("tabindex", "0");
    parent.appendChild(canvas);

    // Disks
    const diskManifestBaseUrl = ensureTrailingSlash(
        options.diskManifestBaseUrl ?? `${BASE_URL}disks/`
    );
    const disks = (options.disks ?? []).map(spec =>
        makeDiskDef(spec, diskManifestBaseUrl)
    );
    const diskFiles = (options.diskFiles ?? []).map(makeDiskFile);
    const cdroms = options.cdroms ?? [];
    if (disks.length + diskFiles.length + cdroms.length === 0) {
        console.warn("MacEmulator: no disks given; the machine will boot to a blinking disk icon");
    }

    // Hooks consumed by the (build-time patched) upstream ui.ts.
    const sw = options.serviceWorker ?? {};
    const g = globalThis as any;
    g.__macemuServiceWorker = {
        url: sw.url ?? `${BASE_URL}emulator-service-worker.js`,
        scope: sw.scope ?? defaultServiceWorkerScope(),
    };
    g.__macemuChunkBaseUrl = stripTrailingSlash(options.chunkBaseUrl ?? "/Disk");

    let settings: EmulatorSettings = {
        ...DEFAULT_EMULATOR_SETTINGS,
        ...options.settings,
    };
    const flags: EmulatorConfigFlags = {...options.flags};

    const config: EmulatorConfig = {
        machine,
        ramSize,
        useSharedMemory,
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenCanvas: canvas,
        disks,
        diskFiles,
        cdroms,
        flags,
    };

    // State
    let destroyed = false;
    let loaded = false;
    let diskActivityTimeout: number | undefined;
    let resolveReady!: (h: MacEmulatorHandle) => void;
    let rejectReady!: (e: Error) => void;
    const ready = new Promise<MacEmulatorHandle>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // Avoid an unhandled rejection when the caller does not use `ready`.
    ready.catch(() => {});

    const inIframe = window.parent !== window;
    const embedMessages = options.embedMessages ?? inIframe;
    // Posted to window.parent like Infinite Mac's /embed page does. When the
    // page is top-level, parent === window, so the page itself receives it;
    // harmless, and it lets a driver listen the same way in both cases.
    const sendEmbedNotification = (event: EmbedNotificationEvent) => {
        window.parent.postMessage(event, "*");
    };

    const fail = (message: string, raw?: string) => {
        console.error("MacEmulator:", message);
        if (window.__macBootError === undefined) {
            window.__macBootError = message;
        }
        if (!loaded) {
            rejectReady(new Error(message));
        }
        options.onError?.(message, raw);
    };

    const delegate: EmulatorDelegate = {
        emulatorDidFinishLoading(emulator) {
            loaded = true;
            emulator.refreshSettings();
            window.__macBooted = true;
            sendEmbedNotification({type: "emulator_loaded"});
            resolveReady(handle);
            options.onLoaded?.(handle);
        },
        emulatorDidMakeLoadingProgress(_emulator, total, left) {
            options.onProgress?.(total - left, total);
        },
        emulatorDidChangeScreenSize(width, height) {
            canvas.width = width;
            canvas.height = height;
            options.onScreenSize?.(width, height);
        },
        emulatorDidStartToLoadDiskChunk() {
            window.clearTimeout(diskActivityTimeout);
            options.onDiskActivity?.(true);
        },
        emulatorDidFinishLoadingDiskChunk() {
            window.clearTimeout(diskActivityTimeout);
            diskActivityTimeout = window.setTimeout(
                () => options.onDiskActivity?.(false),
                200
            );
        },
        emulatorDidBecomeQuiescent() {
            options.onQuiescent?.();
        },
        emulatorStatsDidChange(_emulator, stats) {
            options.onStats?.(stats);
        },
        emulatorDidRunOutOfMemory() {
            fail("The emulator ran out of memory.");
        },
        emulatorDidHaveError(_emulator, error, errorRaw) {
            fail(error, errorRaw);
        },
        emulatorDidExit() {
            teardown();
            options.onExit?.();
        },
        emulatorSettings() {
            return settings;
        },
        emulatorDidDrawScreen(_emulator, imageData) {
            if (options.screenUpdateMessages && embedMessages) {
                sendEmbedNotification({
                    type: "emulator_screen",
                    data: imageData.data,
                    width: imageData.width,
                    height: imageData.height,
                });
            }
        },
    };

    const emulator = new Emulator(config, delegate);

    const handleControlMessage = (e: MessageEvent) => {
        if (e.source !== window.parent || !inIframe) {
            return;
        }
        const event = e.data as EmbedControlEvent;
        if (!event || typeof event !== "object") {
            return;
        }
        switch (event.type) {
            case "emulator_pause":
                emulator.pause();
                break;
            case "emulator_unpause":
                emulator.unpause();
                break;
            case "emulator_mouse_move": {
                const {x, y, deltaX, deltaY} = event;
                emulator.handleExternalInput({type: "mousemove", x, y, deltaX, deltaY});
                break;
            }
            case "emulator_mouse_down":
                emulator.handleExternalInput({type: "mousedown", button: event.button});
                break;
            case "emulator_mouse_up":
                emulator.handleExternalInput({type: "mouseup", button: event.button});
                break;
            case "emulator_key_down":
                emulator.handleExternalInput({type: "keydown", code: event.code});
                break;
            case "emulator_key_up":
                emulator.handleExternalInput({type: "keyup", code: event.code});
                break;
            case "emulator_load_disk":
                console.warn(
                    "MacEmulator: emulator_load_disk needs CD-ROM metadata; use handle.loadCDROM({name, srcUrl, fileSize, fetchClientSide: true}) instead"
                );
                break;
        }
    };
    if (embedMessages) {
        window.addEventListener("message", handleControlMessage);
    }

    let started = false;
    let stoppedForPageHide = false;

    // When the page goes away, ask the worker to stop right now rather than
    // waiting for the browser to tear it down: a persistent disk holds an
    // OPFS sync-access lock that the next page (a reload, or the next title)
    // otherwise finds still taken. Unpause first, because a paused worker is
    // blocked in Atomics.wait and would never see the stop flag.
    const handlePageHide = () => {
        if (!started || destroyed || stoppedForPageHide) {
            return;
        }
        stoppedForPageHide = true;
        try {
            emulator.unpause();
            emulator.stop();
        } catch (e) {
            console.warn("MacEmulator: stop on pagehide failed", e);
        }
    };
    // If the page comes back from the back/forward cache the worker we
    // stopped is gone; reboot the machine rather than show a frozen screen.
    const handlePageShow = (event: PageTransitionEvent) => {
        if (!event.persisted || !stoppedForPageHide || destroyed) {
            return;
        }
        stoppedForPageHide = false;
        emulator.restart().catch(e => {
            fail(`Could not restart after returning to the page: ${e}`);
        });
    };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    const start = async () => {
        if (destroyed) {
            throw new Error("MacEmulator: handle was destroyed");
        }
        if (started) {
            return;
        }
        started = true;
        try {
            await emulator.start();
        } catch (e) {
            fail(e instanceof Error ? e.message : String(e));
            throw e;
        }
    };

    const teardown = () => {
        if (destroyed) {
            return;
        }
        destroyed = true;
        window.removeEventListener("message", handleControlMessage);
        window.removeEventListener("pagehide", handlePageHide);
        window.removeEventListener("pageshow", handlePageShow);
        window.clearTimeout(diskActivityTimeout);
        for (const diskFile of diskFiles) {
            URL.revokeObjectURL(diskFile.url);
        }
        canvas.remove();
    };

    const handle: MacEmulatorHandle = {
        canvas,
        machine: machineInfo,
        useSharedMemory,
        emulator,
        ready,
        start,
        pause() {
            emulator.pause();
        },
        unpause() {
            emulator.unpause();
        },
        uploadFiles(files, names) {
            return emulator.uploadFiles(Array.from(files), names);
        },
        loadCDROM(cdrom) {
            return emulator.loadCDROM(cdrom);
        },
        restart() {
            return emulator.restart();
        },
        sendInput(event) {
            emulator.handleExternalInput(event);
        },
        setSettings(partial) {
            settings = {...settings, ...partial};
            emulator.refreshSettings();
        },
        destroy() {
            if (destroyed) {
                return;
            }
            if (started) {
                // Signals the worker to stop; it is terminated once it
                // acknowledges (emulator_stopped).
                emulator.stop();
            }
            teardown();
        },
    };

    if (options.autoStart !== false) {
        start().catch(() => {
            // Reported through onError / window.__macBootError already.
        });
    }
    return handle;
}

// ---------------------------------------------------------------------------
// Global
// ---------------------------------------------------------------------------
//
// The bundle is an IIFE with no module exports (Vite's app build drops entry
// exports), so the API is installed on the global object explicitly.

export type MacEmulatorApi = {
    readonly version: string;
    create(options: MacEmulatorOptions): MacEmulatorHandle;
    machines(): MachineInfo[];
    sharedMemoryAvailable(): boolean;
};

declare global {
    // eslint-disable-next-line no-var
    var MacEmulator: MacEmulatorApi;
}

const api: MacEmulatorApi = Object.freeze({
    version,
    create,
    machines,
    sharedMemoryAvailable,
});

globalThis.MacEmulator = api;
