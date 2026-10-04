import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import type { PixelImage } from '../../core/index.js';

export function encodePNG(image: PixelImage): Buffer { return PNG.sync.write({ width: image.width, height: image.height, data: Buffer.from(image.data) } as PNG, { colorType: 6, inputColorType: 6 }); }
export function encodeJPEG(image: PixelImage): Buffer { return jpeg.encode({ width: image.width, height: image.height, data: Buffer.from(image.data) }, 95).data; }
