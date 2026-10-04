import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import type { PixelImage } from '../../core/index.js';

export function encodePNG(image: PixelImage): Buffer { return PNG.sync.write({ width: image.width, height: image.height, data: Buffer.from(image.data) } as PNG, { colorType: 6, inputColorType: 6 }); }
export function encodeJPEG(image: PixelImage): Buffer { return jpeg.encode({ width: image.width, height: image.height, data: Buffer.from(image.data) }, 95).data; }

/** Reduce both dimensions for model vision, averaging pixels to preserve fine details. */
export function encodeVisionJPEG(image: PixelImage, divisor = 4): Buffer {
  if (!Number.isInteger(divisor) || divisor < 1 || divisor > 64) throw new Error('Image divisor must be an integer from 1 to 64.');
  if (divisor === 1) return encodeJPEG(image);
  const width = Math.max(1, Math.floor(image.width / divisor)), height = Math.max(1, Math.floor(image.height / divisor));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left = Math.floor(x * image.width / width), right = Math.floor((x + 1) * image.width / width);
    const top = Math.floor(y * image.height / height), bottom = Math.floor((y + 1) * image.height / height);
    const sum = [0, 0, 0, 0];
    for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
      const offset = (row * image.width + col) * 4;
      for (let channel = 0; channel < 4; channel++) sum[channel] += image.data[offset + channel];
    }
    const samples = (right - left) * (bottom - top), offset = (y * width + x) * 4;
    for (let channel = 0; channel < 4; channel++) data[offset + channel] = Math.round(sum[channel] / samples);
  }
  return encodeJPEG({ width, height, data });
}
