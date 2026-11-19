import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { MAX_OBJ_BYTES, parseObjUVLayout, type UVLayout } from "./obj.ts";

export type ParseResult = { layout: UVLayout; sha256: string } | { error: string };

self.addEventListener("message", async (event: MessageEvent<File>) => {
  const file = event.data;
  let result: ParseResult;
  try {
    if (file.size > MAX_OBJ_BYTES) throw Error("OBJ files may be at most 32 MiB.");
    const bytes = await file.arrayBuffer();
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw Error("OBJ files must use valid UTF-8 encoding."); }
    result = { layout: parseObjUVLayout(source), sha256: bytesToHex(sha256(new Uint8Array(bytes))) };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(result);
});
