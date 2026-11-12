import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Cloud models baked from the Blender library (blender_clouds/bake_volumes.py): loads the slice
// atlases listed in data/clouds/models/manifest.json into two 3D textures and the per-type
// parameters the shaders use (volumeGLSL: heapField / layerField / modelExtinction).
// ---------------------------------------------------------------------------------------------

export const HEAP_ORDER = ['cumulus_humilis', 'cumulus_mediocris', 'cumulus_congestus', 'cumulonimbus'];
export const LAYER_ORDER = ['stratocumulus', 'stratus', 'nimbostratus', 'altocumulus', 'altostratus', 'cirrus', 'cirrocumulus', 'cirrostratus'];
// size of each layer's smallest pattern element (km), from the library's 'cell' parameters
const LAYER_FEATURE_KM = { stratocumulus: 1.25, stratus: 4.0, nimbostratus: 2.9, altocumulus: 0.6, altostratus: 5.0, cirrus: 1.0, cirrocumulus: 0.17, cirrostratus: 6.7 };

function placeholder3D() {
  const t = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
  t.format = THREE.RedFormat;
  t.needsUpdate = true;
  return t;
}

export function cloudModelUniforms() {
  const v4 = (n) => Array.from({ length: n }, () => new THREE.Vector4());
  return {
    uHeapTex: { value: placeholder3D() },
    uLayerTex: { value: placeholder3D() },
    uModelsOn: { value: 0 },
    uHeapA: { value: v4(4) }, uHeapB: { value: v4(4) }, uHeapC: { value: v4(4) },
    uLayerA: { value: v4(8) },
    uLayerQ: { value: v4(72) },
    uLayerB: { value: v4(8) },
    uCloudRes: { value: 1 },   // resolution scale of the cloud pass (set by CloudPass.setQuality)
    uLayerSlices: { value: 1 },
  };
}

// decode a slice atlas PNG (8 columns of nx x ny slices) into [z][y][x] bytes at `out[offset]`
async function readSlices(url, nx, ny, nz, out, offset, canvas) {
  const img = await new THREE.ImageLoader().loadAsync(url);
  canvas.width = img.width; canvas.height = img.height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const px = g.getImageData(0, 0, img.width, img.height).data;
  for (let z = 0; z < nz; z++) {
    const r = Math.floor(z / 8), c = z % 8;
    for (let y = 0; y < ny; y++) {
      const row = (r * ny + y) * img.width + c * nx;
      const dst = offset + (z * ny + y) * nx;
      for (let x = 0; x < nx; x++) out[dst + x] = px[(row + x) * 4];
    }
  }
}

export async function loadCloudModels(shared, base = 'data/clouds/models/') {
  const man = await (await fetch(base + 'manifest.json')).json();
  const canvas = document.createElement('canvas');

  // heaps: every variant of every type stacked along z, 64 slices each
  const hres = man.heaps[HEAP_ORDER[0]].res;
  const nVar = HEAP_ORDER.reduce((a, k) => a + man.heaps[k].variants.length, 0);
  const heapData = new Uint8Array(hres[0] * hres[1] * hres[2] * nVar);
  let slab = 0;
  const jobs = [];
  HEAP_ORDER.forEach((k, i) => {
    const h = man.heaps[k];
    const halfKm = h.halfM.map((v) => v / 1000);
    const box = h.box && h.box.length ? h.box : null;
    // cumulonimbus: a fixed 32 x 20 km box; cumulus: square-ish, half-widths from the scene statistics
    const aspect = box ? box[1] / box[0] : 1.0;
    const halfMin = box ? box[0] / 1000 : halfKm[0], halfMax = box ? box[0] / 1000 : halfKm[1];
    const tall = box ? [box[2] / box[0], box[2] / box[0]] : h.tall;
    // grid cell: room for random positions around the largest cloud of the type
    const cell = Math.max(3.0 * halfMax * Math.max(aspect, 1) * 1.1, 2.5);
    shared.uHeapA.value[i].set(slab, h.variants.length, halfMin, halfMax);
    shared.uHeapB.value[i].set(tall[0], tall[1], h.baseM / 1000, h.extinctionPerKm * h.variants[0].peak);
    shared.uHeapC.value[i].set(cell, aspect, hres[2] * nVar, 0);
    h.variants.forEach((v) => {
      jobs.push(readSlices(base + v.file, hres[0], hres[1], hres[2], heapData, slab * hres[0] * hres[1] * hres[2], document.createElement('canvas')));
      slab++;
    });
  });

  // layers: one tileable patch per type, 24 slices each
  const lres = man.layers[LAYER_ORDER[0]].res;
  const layerData = new Uint8Array(lres[0] * lres[1] * lres[2] * LAYER_ORDER.length);
  LAYER_ORDER.forEach((k, i) => {
    const l = man.layers[k];
    shared.uLayerA.value[i].set(i, l.tileKm, l.thickM / 1000, l.soft);
    shared.uLayerB.value[i].set(LAYER_FEATURE_KM[k], 0, 0, 0);
    for (let j = 0; j < 33; j++) shared.uLayerQ.value[i * 9 + (j >> 2)].setComponent(j & 3, l.q[j]);
    jobs.push(readSlices(base + l.file, lres[0], lres[1], lres[2], layerData, i * lres[0] * lres[1] * lres[2], document.createElement('canvas')));
  });
  await Promise.all(jobs);

  const tex3d = (data, w, h, d, wrap) => {
    const t = new THREE.Data3DTexture(data, w, h, d);
    t.format = THREE.RedFormat;
    t.type = THREE.UnsignedByteType;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = wrap;
    t.wrapR = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = true;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
  };
  shared.uHeapTex.value = tex3d(heapData, hres[0], hres[1], hres[2] * nVar, THREE.ClampToEdgeWrapping);
  shared.uLayerTex.value = tex3d(layerData, lres[0], lres[1], lres[2] * LAYER_ORDER.length, THREE.RepeatWrapping);
  shared.uLayerSlices.value = lres[2] * LAYER_ORDER.length;
  shared.uModelsOn.value = 1;
  shared.uModelsLoaded = true;
  void canvas;
  return man;
}
