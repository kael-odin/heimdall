/**
 * 3d-force-graph supports an opt-in WebGPU renderer, but Heimdall always uses
 * the WebGL renderer. The upstream package imports `three/webgpu` eagerly, which
 * pulls the full WebGPU/TSL stack into the graph chunk even though it is never
 * instantiated. Keep the export shape and fail loudly only if a caller opts in.
 */
export class WebGPURenderer {
  constructor() {
    throw new Error('Heimdall console bundles the WebGL renderer only.');
  }
}
