import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = new URL("../examples/motion/", import.meta.url);
mkdirSync(fileURLToPath(directory), { recursive: true });

// Original Apache-2.0 biped. The only Mixamo-compatible data is the joint naming.
const bones = [
  ["Hips", "", [0, .9, 0]],
  ["Spine", "Hips", [0, .18, 0]],
  ["Spine1", "Spine", [0, .16, 0]],
  ["Spine2", "Spine1", [0, .14, 0]],
  ["Neck", "Spine2", [0, .12, 0]],
  ["Head", "Neck", [0, .14, 0]],
];
for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
  bones.push(
    [side + "Shoulder", "Spine2", [.12 * sign, .07, 0]],
    [side + "Arm", side + "Shoulder", [.12 * sign, 0, 0]],
    [side + "ForeArm", side + "Arm", [.25 * sign, 0, 0]],
    [side + "Hand", side + "ForeArm", [.22 * sign, 0, 0]],
    [side + "UpLeg", "Hips", [.1 * sign, 0, 0]],
    [side + "Leg", side + "UpLeg", [0, -.43, 0]],
    [side + "Foot", side + "Leg", [0, -.43, 0]],
    [side + "ToeBase", side + "Foot", [0, -.02, .12]],
  );
}
const idByName = new Map(bones.map(([name], i) => [name, 100 + i]));
const header = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
}
GlobalSettings:  {
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "FrontAxis", "int", "Integer", "",2
		P: "FrontAxisSign", "int", "Integer", "",1
		P: "CoordAxis", "int", "Integer", "",0
		P: "CoordAxisSign", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",100
	}
}
Objects:  {
`;

function file(namespace, takes) {
  const objects = [], links = [];
  for (const [name, parent, position] of bones) {
    const id = idByName.get(name);
    objects.push(`	Model: ${id}, "Model::${namespace}${name}", "LimbNode" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",${position}
			P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
			P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
			P: "RotationOrder", "enum", "", "",5
		}
	}`);
    links.push(`	C: "OO",${id},${idByName.get(parent) ?? 0}`);
  }
  let next = 1000;
  for (const [name, channels] of takes) {
    const stack = next++, layer = next++;
    objects.push(`	AnimationLayer: ${layer}, "AnimLayer::BaseLayer", "" {
	}
	AnimationStack: ${stack}, "AnimStack::${name}", "" {
	}`);
    links.push(`	C: "OO",${layer},${stack}`);
    for (const [joint, kind, samples] of channels) {
      const node = next++;
      objects.push(`	AnimationCurveNode: ${node}, "AnimCurveNode::${kind}", "" {
	}`);
      links.push(`	C: "OO",${node},${layer}`, `	C: "OP",${node},${idByName.get(joint)},"Lcl ${kind === "T" ? "Translation" : "Rotation"}"`);
      for (let axis = 0; axis < 3; axis++) {
        const curve = next++, values = samples.map(sample => sample[axis]);
        objects.push(`	AnimationCurve: ${curve}, "AnimCurve::${joint}${kind}${axis}", "" {
		Default: 0
		KeyVer: 4008
		KeyTime: *3 {
			a: 0,23093079000,46186158000
		}
		KeyValueFloat: *3 {
			a: ${values}
		}
	}`);
        links.push(`	C: "OP",${curve},${node},"d|${"XYZ"[axis]}"`);
      }
    }
  }
  return header + objects.join("\n") + "\n}\nConnections:  {\n" + links.join("\n") + "\n}\n";
}

const takes = [
  ["Arm Sweep", [["LeftArm", "R", [[0, 0, 0], [0, 0, 42], [0, 0, 12]]]]],
  ["Root Travel", [["Hips", "T", [[0, .9, 0], [.1, .9, .3], [.2, .9, .6]]]]],
];
writeFileSync(new URL("matching-rig.fbx", directory), file("mixamorig:", []));
writeFileSync(new URL("motion-takes.fbx", directory), file("shot:mixamorig2:", takes));
