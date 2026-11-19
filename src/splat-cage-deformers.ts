import { polygonCageSplatDeformer } from "./splat-cage.ts";
import { latticeSplatDeformer } from "./splat-lattice.ts";

export const CAGE_SPLAT_DEFORMERS = [latticeSplatDeformer, polygonCageSplatDeformer] as const;
