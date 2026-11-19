import { SPLAT_BEND } from "./splat-bend.ts";
import { SPLAT_SQUASH } from "./splat-squash.ts";
import { SPLAT_TWIST } from "./splat-twist.ts";

export const NONLINEAR_SPLAT_DEFORMERS = [SPLAT_BEND, SPLAT_TWIST, SPLAT_SQUASH] as const;
