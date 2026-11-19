import type { CropBounds } from "./splat-ply-crop";

export const MAX_REGIONS = 32;
export const MAX_REGION_NAME = 48;
export type CaptureRegion = { name: string; enabled: boolean; bounds: CropBounds };

export function checkRegionName(value: string, used: readonly string[]): void {
  if (value.length > MAX_REGION_NAME || !/^[a-z0-9](?:[a-z0-9 _-]*[a-z0-9])?$/i.test(value)) {
    throw new Error("Use 1–48 letters, digits, spaces, hyphens or underscores. Start and end with a letter or digit.");
  }
  if (/^(?:remainder|con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) {
    throw new Error("That name is reserved. Enter another region name.");
  }
  if (used.some(name => name.toLowerCase() === value.toLowerCase())) {
    throw new Error("Region names must be unique, ignoring case.");
  }
}
