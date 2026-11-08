import type { CustomAttribute } from "./custom-attributes.ts";

export type EnumEntry = { id: string; name: string; value: number };
export type CustomAttributeType = "float" | "boolean" | "enum";
export const MAX_ENUM_ENTRIES = 64;
export const MAX_ENUM_CODE = 1_000_000;
export const attributeType = (attribute?: CustomAttribute): CustomAttributeType => attribute?.type ?? "float";
export const isDiscreteAttribute = (attribute?: CustomAttribute) => !!attribute && attributeType(attribute) !== "float";
export const attributeTypeLabel = (attribute?: CustomAttribute) => ({ float: "Float", boolean: "Boolean", enum: "Enum" })[attributeType(attribute)];
export function attributeChoices(attribute: CustomAttribute): { name: string; value: number }[] {
  return attribute.type === "boolean" ? [{ name: "Off", value: 0 }, { name: "On", value: 1 }] : attribute.entries ?? [];
}
export function validDiscreteValue(attribute: CustomAttribute, value: number): boolean {
  return attributeChoices(attribute).some(entry => entry.value === value);
}
export function formatAttributeValue(attribute: CustomAttribute, value: number): string {
  return attributeChoices(attribute).find(entry => entry.value === value)?.name ?? String(value);
}
export function makeEnumEntries(names: string[]): { entries: EnumEntry[]; nextValue: number } {
  return { entries: names.map((name, value) => ({ id: crypto.randomUUID(), name, value })), nextValue: names.length };
}
export function validateAttributeType(attribute: CustomAttribute, validId: (id: unknown) => boolean): void {
  if (attribute.type !== undefined && !["float", "boolean", "enum"].includes(attribute.type)) throw Error("Unsupported custom attribute type.");
  if (attribute.type !== "enum") {
    if (attribute.entries !== undefined || attribute.nextValue !== undefined) throw Error("Only Enum attributes have entries and an entry-code counter.");
  } else {
    if (!Array.isArray(attribute.entries) || attribute.entries.length < 1 || attribute.entries.length > MAX_ENUM_ENTRIES
      || !Number.isSafeInteger(attribute.nextValue) || attribute.nextValue! < 1 || attribute.nextValue! > MAX_ENUM_CODE + 1) throw Error("Enum attributes need 1–64 choices and a valid next entry code.");
    const ids = new Set<string>(), names = new Set<string>(), values = new Set<number>();
    for (const entry of attribute.entries) {
      if (!entry || !validId(entry.id) || ids.has(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name !== entry.name.trim() || entry.name.length > 80
        || names.has(entry.name.toLowerCase()) || !Number.isSafeInteger(entry.value) || entry.value < 0 || entry.value > MAX_ENUM_CODE || entry.value >= attribute.nextValue!
        || values.has(entry.value) || Object.keys(entry).some(key => !["id", "name", "value"].includes(key))) throw Error("Invalid or duplicate enum entry ID, label or permanent code.");
      ids.add(entry.id); names.add(entry.name.toLowerCase()); values.add(entry.value);
    }
  }
  if (isDiscreteAttribute(attribute)) {
    if (attribute.min !== undefined || attribute.max !== undefined) throw Error("Boolean and Enum attributes use their choices, not numeric minimum/maximum limits.");
    if (!validDiscreteValue(attribute, attribute.default) || !validDiscreteValue(attribute, attribute.value)) throw Error("Default and current value must be an existing discrete choice.");
  }
}
