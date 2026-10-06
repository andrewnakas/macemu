// Type-check only. The generated disk manifests that src/defs/disks.ts
// imports are absent from this checkout; declare them so `tsc -p
// runtime/tsconfig.json` can still check the upstream sources we bundle.
// (At build time src/defs/disks.ts is replaced by runtime/disks.ts.)
declare module "*.dsk.json" {
    const spec: {
        name: string;
        totalSize: number;
        chunks: string[];
        chunkSize: number;
        scrnResourceOffset?: number;
    };
    export default spec;
}
