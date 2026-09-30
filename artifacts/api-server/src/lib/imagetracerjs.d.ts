declare module "imagetracerjs" {
  interface ImageDataLike { width: number; height: number; data: Uint8ClampedArray; }
  interface TraceOptions { [key: string]: unknown; }
  interface TracedData { width: number; height: number; layers: unknown[]; palette: unknown[]; }
  const ImageTracer: {
    imagedataToTracedata(data: ImageDataLike, options?: TraceOptions): TracedData;
    getsvgstring(data: TracedData, options?: TraceOptions): string;
  };
  export default ImageTracer;
}