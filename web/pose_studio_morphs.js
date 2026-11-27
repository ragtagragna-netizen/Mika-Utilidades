import { calculateMorphFactors } from "./pose_studio/morph_runtime.mjs";

// Genera targets de morph por parte del cuerpo, como los que usan MakeHuman,
// COM3D2 o Character Creator: cada target guarda SOLO el desplazamiento de los
// vértices de esa zona y el slider mezcla targets. La pertenencia se toma de los
// pesos de piel del propio rig (skinIndex/skinWeight) y el engrosamiento se
// calcula en el eje real de cada hueso, nunca en ejes globales.

const C = {
	waist: ["spine_01", "spine_02"],
	stomach: ["spine_01", "spine_02"],
	hips: ["pelvis", "thigh_l", "thigh_r"],
	glutes: ["pelvis", "thigh_l", "thigh_r"],
	arm: ["upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r", "hand_l", "hand_r"],
	thigh: ["thigh_l", "thigh_r"],
	calf: ["calf_l", "calf_r", "foot_l", "foot_r"],
	armLength: ["lowerarm_l", "lowerarm_r", "hand_l", "hand_r"],
	legLength: ["calf_l", "calf_r", "foot_l", "foot_r"],
	pubis: ["pelvis"],
};

const smooth = (d) => {
	const t = Math.max(0, Math.min(1, d));
	return (1 - t * t) * (1 - t * t);
};

const smoothstep = (d) => {
	const t = Math.max(0, Math.min(1, d));
	return t * t * (3 - 2 * t);
};

const segmentLengthFactor = (value) => 1 + ((value ?? 0.5) - 0.5) * 1.1;
const NEIGHBOR_CACHE = new WeakMap();

function meshNeighbors(pack, staticData, count) {
	const indexLength = staticData.indices.length;
	let byLength = NEIGHBOR_CACHE.get(pack);
	if (!byLength) {
		byLength = new Map();
		NEIGHBOR_CACHE.set(pack, byLength);
	}
	if (byLength.has(indexLength)) return byLength.get(indexLength);
	const neighbors = new Array(count);
	for (let i = 0; i < count; i++) neighbors[i] = [];
	const idx = staticData.indices;
	for (let i = 0; i < idx.length; i += 3) {
		const a = idx[i], b = idx[i + 1], c = idx[i + 2];
		neighbors[a].push(b, c);
		neighbors[b].push(a, c);
		neighbors[c].push(a, b);
	}
	byLength.set(indexLength, neighbors);
	return neighbors;
}

// Mantiene los pivotes sobre la malla alargada: el siguiente tramo recibe el
// desplazamiento completo del anterior, pero conserva su propia longitud.
export function adjustLimbLengthBonePositions(bonePositions, boneNames, localDeform = {}) {
	for (const side of ["l", "r"]) {
		const deltas = {};
		const wholeFactor = 1 + ((localDeform.legLength ?? 0.5) - 0.5) * 0.55;
		for (const segment of ["thigh", "calf"]) {
			const index = boneNames.indexOf(segment + "_" + side);
			if (index < 0) continue;
			const o = index * 6;
			const dx = bonePositions[o + 3] - bonePositions[o];
			const dy = bonePositions[o + 4] - bonePositions[o + 1];
			const dz = bonePositions[o + 5] - bonePositions[o + 2];
			const factor = segmentLengthFactor(localDeform[segment + "Length"]);
			const combined = factor + wholeFactor - 2;
			deltas[segment] = [dx * combined, dy * combined, dz * combined];
		}
		const thigh = deltas.thigh || [0, 0, 0];
		const calf = deltas.calf || [0, 0, 0];
		const shift = (name, tail, delta) => {
			const index = boneNames.indexOf(name);
			if (index < 0) return;
			const o = index * 6 + (tail ? 3 : 0);
			for (let axis = 0; axis < 3; axis++) bonePositions[o + axis] += delta[axis];
		};
		shift("thigh_" + side, true, thigh);
		for (const name of ["calf_", "foot_", "ball_"]) {
			const full = name === "calf_" ? thigh : thigh.map((v, i) => v + calf[i]);
			shift(name + side, false, full);
			shift(name + side, true, full);
			if (name === "calf_") shift(name + side, true, calf);
		}
	}
}

export function buildCustomMorphs(pack, solved, staticData, params = {}) {
	const verts = solved.vertices;
	const rest = new Float32Array(verts);
	const count = verts.length / 3;
	const skin = staticData.skinIndices;
	const weights = staticData.skinWeights;
	const names = pack.bones.map((b) => b.name);
	const bonePos = solved.bonePositions;
	const byName = new Map(names.map((n, i) => [i, n]));
	const boneSet = (prefixes) => new Set(
		names.filter((n) => prefixes.some((p) => n.startsWith(p))));
	// Incluye TODOS los huesos del miembro (dedos, pie, ball): si el peso de
	// un dedo no se cuenta, la mano se queda atrás y se ve un desgarro.
	const ARM_SET = boneSet(["upperarm_", "lowerarm_", "hand_", "index_",
		"middle_", "ring_", "pinky_", "thumb_"]);
	const HAND_SET = boneSet(["hand_", "index_", "middle_", "ring_", "pinky_", "thumb_"]);
	const FOOT_SET = boneSet(["foot_", "ball_"]);
	const THIGH_CHAIN_SET = boneSet(["thigh_", "calf_", "foot_", "ball_"]);
	const CALF_CHAIN_SET = boneSet(["calf_", "foot_", "ball_"]);

	let minY = Infinity;
	let maxY = -Infinity;
	for (let i = 1; i < verts.length; i += 3) {
		minY = Math.min(minY, verts[i]);
		maxY = Math.max(maxY, verts[i]);
	}
	const span = Math.max(0.001, maxY - minY);
	const pubisY = minY + 0.53 * span;
	// Centro de los glúteos medido sobre el asset en reposo
	// (glute peak ≈ [±0.36, -1.32, -0.75]), en fracción de la altura para que
	// siga al cuerpo cuando cambian gender/weight/altura nativa.
	const gluteY = minY + 0.52 * span;
	const gluteX = 0.033 * span;
	const gluteZ = -0.025 * span;

	const keys = ["waist", "stomach", "hips", "glutes", "gluteWidth", "gluteHeight", "arm", "thigh",
		"calf", "armLength", "legLength", "thighLength", "calfLength", "pubis", "height", "width",
		"handSize", "footSize", "penisRot"];
	const targets = {};
	const delta = (k, i, x, y, z) => {
		const a = targets[k] || (targets[k] = new Float32Array(verts.length));
		a[i] += x;
		a[i + 1] += y;
		a[i + 2] += z;
	};

	const d = params.localDeform || {};
	const rotX = (d.penisRotX ?? 0) * Math.PI / 180;
	const rotY = (d.penisRotY ?? 0) * Math.PI / 180;
	const rotZ = (d.penisRotZ ?? 0) * Math.PI / 180;
	// Por encima de 1 el target procedural sigue al morph nativo: en 2.5 el
	// largo llega a ×2 y el grosor a ×5, medidos desde el ancla.
	const lenExtra = Math.max(0, (d.penisLength ?? 0.5) - 1);
	const girthExtra = Math.max(0, (d.penisGirth ?? 0.5) - 1);
	const fLen = 1 + lenExtra * 2 / 3;
	const fGirth = 1 + girthExtra * 8 / 3;
	const fWaist = Math.max(0.3, 1 + (0.5 - (d.waist ?? 0.5)) * 0.5);
	const fStomach = 1 + ((d.stomach ?? 0.5) - 0.5) * 0.65;
	const fHand = 1 + ((d.handSize ?? 0.5) - 0.5) * 0.6;
	const fFoot = 1 + ((d.footSize ?? 0.5) - 0.5) * 0.6;
	const hipScale = ((d.hips ?? 0.5) - 0.5) / 1.1;
	const fGlute = 1 + ((d.glutes ?? 0.5) - 0.5) * 1.7;
	const fGluteWidth = 1 + ((d.gluteWidth ?? 0.5) - 0.5) * 1.0;
	const fGluteHeight = 1 + ((d.gluteHeight ?? 0.5) - 0.5) * 1.0;
	const raw = params.rawAnatomy || {};
	const fArm = 1 + ((d.armThickness ?? 0.5) - 0.5) * 0.5;
	const fThigh = 1 + ((d.thighThickness ?? 0.5) - 0.5) * 0.5;
	const fCalf = 1 + ((d.calfThickness ?? 0.5) - 0.5) * 0.5;
	const fArmLen = 1 + ((d.armLength ?? 0.5) - 0.5) * 0.55;
	const fLegLen = 1 + ((d.legLength ?? 0.5) - 0.5) * 0.55;
	const fThighLen = segmentLengthFactor(d.thighLength);
	const fCalfLen = segmentLengthFactor(d.calfLength);
	const fPubis = 1 + ((d.genitalSize ?? 0.5) - 0.5) * 0.35;
	// La altura nativa (MakeHuman) cubre 0..1. Fuera de ese rango un residuo
	// continuo estira desde los pies: antes había un salto del 30% al cruzar 0/1.
	const h = d.height ?? 0.5;
	const extraH = h > 1 ? h - 1 : h < 0 ? h : 0;
	const fHeight = 1 + extraH * 0.22;
	// Anchura global: mismo rango y neutral que altura, sin morph nativo.
	const fWidth = 1 + ((d.width ?? 0.5) - 0.5) * 0.45;

	// Eje de cada hueso (cabeza -> cola) en espacio de malla.
	const axis = (index) => {
		const o = index * 6;
		return {
			hx: bonePos[o], hy: bonePos[o + 1], hz: bonePos[o + 2],
			tx: bonePos[o + 3], ty: bonePos[o + 4], tz: bonePos[o + 5],
		};
	};
	for (let v = 0; v < count; v++) {
		const i = v * 3;
		const x = verts[i];
		const y = verts[i + 1];
		const z = verts[i + 2];
		const t = (y - minY) / span;
		const o = v * 4;

		for (let k = 0; k < 4; k++) {
			const w = weights[o + k];
			if (w < 0.02) continue;
			const name = byName.get(skin[o + k]);
			if (!name) continue;

			if (fWaist !== 1 && C.waist.includes(name) && t > 0.52 && t < 0.76) {
				const fall = smooth((Math.abs(t - 0.65) - 0.03) / 0.09) * w;
				delta("waist", i, x * (fWaist - 1) * fall, 0, z * (fWaist - 1) * fall);
			}

			// Vientre / peso: volumen elipsoidal redondeado desde las costillas
			// hasta el pubis, con el frente como eje principal (guías de
			// aumento de peso). El peso nativo también engorda el vientre.
			const bellyF = fStomach * (1 + ((d.weight ?? 0.5) - 0.5) * 0.5);
			if (C.stomach.includes(name) && t > 0.45 && t < 0.78 && bellyF !== 1) {
				const by = minY + 0.6 * span;
				const bz = 0.055 * span;
				const dx = x / (0.09 * span);
				const dy = (y - by) / (0.14 * span);
				const dz = (z - bz) / (0.11 * span);
				const fall = Math.exp(-(dx * dx + dy * dy + dz * dz) * 1.1) * w;
				delta("stomach", i,
					x * (bellyF - 1) * 0.7 * fall,
					(y - by) * (bellyF - 1) * 0.25 * fall,
					(z - bz) * (bellyF - 1) * 0.8 * fall);
			}

			if (fPubis !== 1 && name === "pelvis" && z > 0 && t > 0.49 && t < 0.57) {
				const fall = smooth((Math.abs(t - pubisY) - 0.01) / 0.04) * w;
				delta("pubis", i, x * (fPubis - 1) * fall, 0, z * (fPubis - 1) * fall);
			}

			if (C.arm.includes(name) && fArm !== 1) {
				const a = axis(skin[o + k]);
				let dx = a.tx - a.hx;
				let dy = a.ty - a.hy;
				let dz = a.tz - a.hz;
				const len = Math.hypot(dx, dy, dz) || 1;
				dx /= len; dy /= len; dz /= len;
				const px = x - a.hx, py = y - a.hy, pz = z - a.hz;
				const along = px * dx + py * dy + pz * dz;
				const rx = px - dx * along;
				const ry = py - dy * along;
				const rz = pz - dz * along;
				delta("arm", i, rx * (fArm - 1) * w, ry * (fArm - 1) * w, rz * (fArm - 1) * w);
			}

			if (C.thigh.includes(name) && fThigh !== 1) {
				const a = axis(skin[o + k]);
				let dx = a.tx - a.hx, dy = a.ty - a.hy, dz = a.tz - a.hz;
				const len = Math.hypot(dx, dy, dz) || 1;
				dx /= len; dy /= len; dz /= len;
				const px = x - a.hx, py = y - a.hy, pz = z - a.hz;
				const along = px * dx + py * dy + pz * dz;
				// El volumen del muslo se concentra en su unión con la cadera y
				// desaparece antes de la rodilla, en lugar de inflar toda la pierna.
				const upperGate = smooth((along / len - 0.12) / 0.38);
				let pelvisMix = 0;
				for (let j = 0; j < 4; j++) if (byName.get(skin[o + j]) === "pelvis") pelvisMix += weights[o + j];
				const flexionGuard = (1 - pelvisMix * 0.95) * (1 - smooth(Math.abs(x) / (0.025 * span)));
				delta("thigh", i,
					(px - dx * along) * (fThigh - 1) * w * upperGate * flexionGuard,
					(py - dy * along) * (fThigh - 1) * w * upperGate * flexionGuard * 0.25,
					(pz - dz * along) * (fThigh - 1) * w * upperGate * flexionGuard);
			}

			if (C.calf.includes(name) && fCalf !== 1) {
				const a = axis(skin[o + k]);
				let dx = a.tx - a.hx, dy = a.ty - a.hy, dz = a.tz - a.hz;
				const len = Math.hypot(dx, dy, dz) || 1;
				dx /= len; dy /= len; dz /= len;
				const px = x - a.hx, py = y - a.hy, pz = z - a.hz;
				const along = px * dx + py * dy + pz * dz;
				delta("calf", i,
					(px - dx * along) * (fCalf - 1) * w,
					(py - dy * along) * (fCalf - 1) * w,
					(pz - dz * along) * (fCalf - 1) * w);
			}
		}

		// Largo de miembros: estiramiento desde el hombro / la cadera a lo
		// largo del eje del hueso raíz de CADA miembro (target, no huesos).
		if (fArmLen !== 1) {
			const limbSide = x >= 0 ? "l" : "r";
			const stretchLimb = (target, rootPrefix, factor, boneSetForLimb) => {
				if (Math.abs(factor - 1) < 0.001) return;
				const idx = names.indexOf(rootPrefix + limbSide);
				if (idx < 0) return;
				const a = axis(idx);
				let dx = a.tx - a.hx, dy = a.ty - a.hy, dz = a.tz - a.hz;
				const len = Math.hypot(dx, dy, dz) || 1;
				dx /= len; dy /= len; dz /= len;
				const along = (x - a.hx) * dx + (y - a.hy) * dy + (z - a.hz) * dz;
				if (along <= 0) return;
				// Peso total del miembro: dedos y pie incluidos. Así la mano y
				// el empeine estiran igual que el antebrazo o la pantorrilla.
				let wLimb = 0;
				for (let k = 0; k < 4; k++) {
					if (boneSetForLimb.has(byName.get(skin[o + k]))) {
						wLimb += weights[o + k];
					}
				}
				if (wLimb < 0.01) return;
				const ease = smooth(Math.min(1, along / (0.06 * span)));
				const f = (factor - 1) * along * wLimb * ease;
				delta(target, i, dx * f, dy * f, dz * f);
			};
			stretchLimb("armLength", "upperarm_", fArmLen, ARM_SET);
		}

		// Largo por tramo: dentro del hueso el desplazamiento crece desde su
		// cabeza; a partir de la articulación se limita a su longitud, así los
		// tramos descendientes se trasladan rígidamente y no se despegan.
		const stretchSegment = (target, rootName, factor, chain) => {
			if (Math.abs(factor - 1) < 0.001) return;
			const side = x >= 0 ? "l" : "r";
			const idx = names.indexOf(rootName + side);
			if (idx < 0) return;
			const a = axis(idx);
			let dx = a.tx - a.hx, dy = a.ty - a.hy, dz = a.tz - a.hz;
			const len = Math.hypot(dx, dy, dz) || 1;
			dx /= len; dy /= len; dz /= len;
			const along = (x - a.hx) * dx + (y - a.hy) * dy + (z - a.hz) * dz;
			if (along <= 0) return;
			let chainWeight = 0;
			for (let k = 0; k < 4; k++) {
				if (chain.has(byName.get(skin[o + k]))) chainWeight += weights[o + k];
			}
			if (chainWeight < 0.01) return;
			const amount = (factor - 1) * Math.min(along, len) * chainWeight;
			delta(target, i, dx * amount, dy * amount, dz * amount);
		};
		// El largo general recorre los mismos dos segmentos que los sliders
		// individuales: cada articulación recibe el delta completo del tramo anterior.
		if (fLegLen !== 1) {
			stretchSegment("legLength", "thigh_", fLegLen, THIGH_CHAIN_SET);
			stretchSegment("legLength", "calf_", fLegLen, CALF_CHAIN_SET);
		}
		stretchSegment("thighLength", "thigh_", fThighLen, THIGH_CHAIN_SET);
		stretchSegment("calfLength", "calf_", fCalfLen, CALF_CHAIN_SET);

		// Glúteos: dos lóbulos redondeados en lugar de una banda plana. Cada
		// mejilla crece desde su propio centro (eje Z hacia atrás, algo de X y
		// Y) con una campana que se ensancha al exagerar, y un pliegue central
		// para que no se fundan en una sola masa.
		if ((fGlute !== 1 || fGluteWidth !== 1 || fGluteHeight !== 1) &&
			z < -0.01 && t > 0.42 && t < 0.63) {
			let wg = 0;
			for (let k = 0; k < 4; k++) {
				if (C.glutes.includes(byName.get(skin[o + k]))) wg += weights[o + k];
			}
			if (wg > 0.01) {
				const cx = (x >= 0 ? 1 : -1) * gluteX;
				const dx = (x - cx) / (0.09 * span);
				const dy = (y - gluteY) / (0.095 * span);
				const dz = (z - gluteZ) / (0.085 * span);
				const r2 = dx * dx + dy * dy + dz * dz;
				const widen = 1 + (fGlute - 1) * 0.3;
				const cleft = Math.min(1, Math.abs(x) / (0.022 * span));
				const fall = Math.exp(-r2 * 1.2 / (widen * widen)) * cleft * wg;
				// Proyección radial acotada: la mejilla crece hacia atrás (−Z) con
				// una cota y acompaña en X e Y, de modo que el lóbulo nace redondeado
				// y muere suave en la espalda y la cadera en vez de una aleta.
				const zu = Math.max(0, Math.min(1, (z - (gluteZ - 0.08 * span)) / (0.16 * span)));
				const backRamp = 1 - zu * zu * (3 - 2 * zu);
				const projectionFall = Math.exp(-(dx * dx + dy * dy) * 1.2 / (widen * widen))
					* cleft * backRamp * wg;
				delta("glutes", i,
					(x - cx) * 0.10 * (fGlute - 1) * fall,
					(y - gluteY) * 0.10 * (fGlute - 1) * fall,
					-(fGlute - 1) * 0.039 * span * projectionFall);
				delta("gluteWidth", i, (x - cx) * (fGluteWidth - 1) * 0.9 * fall, 0, 0);
				delta("gluteHeight", i, 0, (y - gluteY) * (fGluteHeight - 1) * 0.7 * fall, 0);
			}
		}

		if (fHeight !== 1) delta("height", i, 0, (y - minY) * (fHeight - 1), 0);
		if (fWidth !== 1) delta("width", i, x * (fWidth - 1), 0, 0);

		// Tamaño de manos y pies: escalado radial desde la muñeca / el tobillo.
		// Se cuentan todos los huesos de la parte (dedos incluidos) para que
		// no queden despegados del resto de la mano.
		for (const [target, factor, set, root] of [
			["handSize", fHand, HAND_SET, "hand_"],
			["footSize", fFoot, FOOT_SET, "foot_"],
		]) {
			if (factor === 1) continue;
			let wPart = 0;
			for (let k = 0; k < 4; k++) {
				if (set.has(byName.get(skin[o + k]))) wPart += weights[o + k];
			}
			if (wPart < 0.01) continue;
			const idx = names.indexOf(root + (x >= 0 ? "l" : "r"));
			if (idx < 0) continue;
			const a = axis(idx);
			delta(target, i,
				(x - a.hx) * (factor - 1) * wPart,
				(y - a.hy) * (factor - 1) * wPart,
				(z - a.hz) * (factor - 1) * wPart);
		}
	}

	// El pene gira alrededor de su ancla en la entrepierna, como un hueso: la
	// raíz (vértice más peso del pelvis) se queda fija y el resto oscila.
	// Es un componente separado, así que no se arrastra el bajo vientre.
	if ((rotX || rotY || rotZ || fLen !== 1 || fGirth !== 1) && pack.genitalIndices?.length) {
		const pelvisIdx = names.indexOf("pelvis");
		const gset = new Set(pack.genitalIndices);
		let ax = 0, ay = pubisY, az = 0, best = -1;
		for (const gi of gset) {
			let wp = 0;
			const o = gi * 4;
			for (let k = 0; k < 4; k++) {
				if (skin[o + k] === pelvisIdx) wp += weights[o + k];
			}
			if (wp > best) {
				best = wp;
				ax = verts[gi * 3];
				ay = verts[gi * 3 + 1];
				az = verts[gi * 3 + 2];
			}
		}
		// Eje del miembro: del ancla al vértice más alejado. El escalado se
		// aplica antes que la rotación para que giren las proporciones ya
		// exageradas y no al revés.
		let tx = ax, ty = ay + 1, tz = az, far = -1;
		for (const gi of gset) {
			const dx = verts[gi * 3] - ax;
			const dy = verts[gi * 3 + 1] - ay;
			const dz = verts[gi * 3 + 2] - az;
			const d2 = dx * dx + dy * dy + dz * dz;
			if (d2 > far) { far = d2; tx = verts[gi * 3]; ty = verts[gi * 3 + 1]; tz = verts[gi * 3 + 2]; }
		}
		let ux = tx - ax, uy = ty - ay, uz = tz - az;
		const ul = Math.hypot(ux, uy, uz) || 1;
		ux /= ul; uy /= ul; uz /= ul;
		const cx = Math.cos(rotX), sx = Math.sin(rotX);
		const cy = Math.cos(rotY), sy = Math.sin(rotY);
		const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
		// Mismo orden que THREE.Euler("XYZ"): q = qx·qy·qz, es decir se
		// aplica Z, luego Y y por último X. Así el hueso del tirador y el
		// target giran exactamente igual.
		const rotate = (x, y, z) => {
			let nx = x * cz - y * sz; let ny = x * sz + y * cz;
			x = nx; y = ny;
			nx = x * cy + z * sy; let nz = -x * sy + z * cy;
			x = nx; z = nz;
			ny = y * cx - z * sx; nz = y * sx + z * cx;
			return [x, ny, nz];
		};
		for (const gi of gset) {
			const i = gi * 3;
			const vx = verts[i] - ax, vy = verts[i + 1] - ay, vz = verts[i + 2] - az;
			const along = vx * ux + vy * uy + vz * uz;
			const rx0 = vx - ux * along, ry0 = vy - uy * along, rz0 = vz - uz * along;
			const sx0 = ux * along * fLen + rx0 * fGirth;
			const sy0 = uy * along * fLen + ry0 * fGirth;
			const sz0 = uz * along * fLen + rz0 * fGirth;
			const r = rotate(sx0, sy0, sz0);
			delta("penisRot", i, r[0] - vx, r[1] - vy, r[2] - vz);
		}
	}

	const accumulateNativeTarget = (out, target, factors, scale = 1) => {
		let weight = scale;
		for (const factor of target.factorValues) weight *= factors[factor] ?? 0;
		if (Math.abs(weight) < 0.001) return;
		for (let i = 0; i < target.count; i++) {
			const vo = target.indices[i] * 3, d = i * 3;
			out[vo] += target.deltas[d] * weight;
			out[vo + 1] += target.deltas[d + 1] * weight;
			out[vo + 2] += target.deltas[d + 2] * weight;
		}
	};

	// Adyacencia real de la malla, compartida por el campo local de cadera y
	// por el resto de targets.
	const neighbors = meshNeighbors(pack, staticData, count);
	// Suaviza un campo escalar (una entrada por vértice) con los vecinos
	// reales de la malla: quita costuras sin desplazar el conjunto.
	const smoothMaskedField = (field, mask, passes) => {
		const copy = new Float32Array(field.length);
		for (let pass = 0; pass < passes; pass++) {
			copy.set(field);
			for (let v = 0; v < count; v++) {
				if (mask[v] <= 0) continue;
				const ns = neighbors[v];
				if (!ns.length) continue;
				let sum = 0;
				for (const n of ns) sum += copy[n];
				field[v] = copy[v] * 0.5 + (sum / ns.length) * 0.5;
			}
		}
	};

	// ------------------------------------------------------------------
	// Pecho
	// ------------------------------------------------------------------
	// Mismo enfoque que VNCCS_Utils: el pecho lo genera el morph pack nativo de
	// MakeHuman con SOLO dos sliders, y sin ninguna deformación procedural:
	//   - tamaño  → breast_size (targets nativos maxcup / mincup)
	//   - firmeza → firmness    (targets nativos maxfirmness / minfirmness)
	// `solveMorph` ya aplica esos targets para breast_size 0..1. Por encima del
	// máximo nativo (bust > 1) se añade otra capa del MISMO target maxcup,
	// escalada linealmente, para que el slider tenga un margen de crecimiento
	// extra. No se toca vientre, espalda, cara ni brazos: los deltas nativos ya
	// están delimitados a la piel del pecho, así que la deformación es local por
	// construcción.
	const bustRaw = Math.max(0, Number(raw.bust ?? 0.5));
	// Margen de crecimiento por encima del máximo nativo: el slider llega a 2.5,
	// así que por encima de 1 se suma hasta media copa más del mismo target
	// maxcup (×1.5 del máximo nativo). Es un margen pequeño a propósito: seguir
	// extrapolando el morph nativo pliega caras en la zona de la areola.
	const cupExtra = Math.max(0, Math.min(0.5, (bustRaw - 1) / 3));
	if (cupExtra > 0) {
		const cupFactors = calculateMorphFactors({ ...params, breast_size: 1 });
		for (const target of pack.targets) {
			if (!target.factorValues.includes("maxcup")) continue;
			accumulateNativeTarget(verts, target, cupFactors, cupExtra);
		}
	}

	// ------------------------------------------------------------------
	// Caderas
	// ------------------------------------------------------------------
	// Ensanchamiento lateral (X) de la pelvis y de la cara EXTERNA del
	// muslo. La cara interior, la rodilla y la parte baja no se mueven; la
	// transición hacia el muslo es progresiva y sin escalones.
	if (hipScale !== 0) {
		const hipField = new Float32Array(count);
		const hipMask = new Float32Array(count);
		const outer = new Float32Array(count);
		const innerGate = 0.045 * span, outerGate = 0.085 * span;
		for (let v = 0; v < count; v++) {
			const i = v * 3, o = v * 4, t = (rest[i + 1] - minY) / span;
			if (t <= 0.38 || t >= 0.64) continue;
			let pelvis = 0, thigh = 0, side = null;
			for (let k = 0; k < 4; k++) {
				const name = byName.get(skin[o + k]);
				if (name === "pelvis") pelvis += weights[o + k];
				if (name === "thigh_l" || name === "thigh_r") {
					thigh += weights[o + k];
					side = name.endsWith("_l") ? "l" : "r";
				}
			}
			if (pelvis <= 0 && thigh <= 0) continue;
			// Solo la cara exterior: la interior queda intacta.
			const gate = smoothstep((Math.abs(rest[i]) - innerGate) / (outerGate - innerGate));
			if (gate <= 0) continue;
			outer[v] = gate;
			const band = smoothstep((t - 0.40) / 0.05) * smoothstep((0.62 - t) / 0.06);
			let weight = pelvis * band;
			if (thigh > 0 && side) {
				// Desvanecido a lo largo del muslo: fuerte arriba, cero en la
				// rodilla (transición suave hacia el muslo).
				const bi = names.indexOf("thigh_" + side) * 6;
				const ax = bonePos[bi + 3] - bonePos[bi];
				const ay = bonePos[bi + 4] - bonePos[bi + 1];
				const az = bonePos[bi + 5] - bonePos[bi + 2];
				const length = Math.hypot(ax, ay, az) || 1;
				const along = ((rest[i] - bonePos[bi]) * ax + (rest[i + 1] - bonePos[bi + 1]) * ay +
					(rest[i + 2] - bonePos[bi + 2]) * az) / (length * length);
				const thighFade = smoothstep((0.55 - along) / 0.25);
				weight += thigh * gate * thighFade * 0.45;
			}
			if (weight <= 0) continue;
			hipMask[v] = Math.min(1, weight);
			hipField[v] = rest[i] * hipMask[v];
		}
		smoothMaskedField(hipField, hipMask, 3);
		// El suavizado puede filtrar hacia la cara interior: se vuelve a
		// aplicar la puerta exterior para que el muslo interno no se mueva.
		for (let v = 0; v < count; v++) hipField[v] *= outer[v];
		let hipPeak = 0;
		for (let v = 0; v < count; v++) hipPeak = Math.max(hipPeak, Math.abs(hipField[v]));
		let smoothHipPeak = 0;
		for (let v = 0; v < count; v++) smoothHipPeak = Math.max(smoothHipPeak, Math.abs(hipField[v]));
		const hipRestore = smoothHipPeak > 1e-8 ? hipPeak / smoothHipPeak : 1;
		for (let v = 0; v < count; v++) verts[v * 3] += hipField[v] * hipRestore * 0.45 * hipScale;
	}

	// Un target neutro no deforma: se descarta para no gastar slots de morph.
	for (const k of keys) {
		let any = false;
		const a = targets[k];
		if (!a) continue;
		for (let j = 0; j < a.length; j++) {
			if (Math.abs(a[j]) > 1e-5) { any = true; break; }
		}
		if (!any) delete targets[k];
	}

	if (!keys.some((key) => targets[key])) return { order: [], vertices: verts, count };

	// Suavizado con la adyacencia real de la malla: quita las costuras donde
	// cambia el hueso dominante (hombro, cadera) sin desplazar el conjunto.
	const idx = staticData.indices;
	const smoothTarget = (arr, passes = 2) => {
		const copy = new Float32Array(arr);
		for (let pass = 0; pass < passes; pass++) {
			copy.set(arr);
			for (let v = 0; v < count; v++) {
				const ns = neighbors[v];
				if (!ns.length) continue;
				for (let axis = 0; axis < 3; axis++) {
					let sum = 0;
					for (const n of ns) sum += copy[n * 3 + axis];
					arr[v * 3 + axis] = copy[v * 3 + axis] * 0.55 + (sum / ns.length) * 0.45;
				}
			}
		}
	};
	const maskThighLowerTarget = (arr) => {
		for (let v = 0; v < count; v++) {
			const i = v * 3, o = v * 4;
			let side = null, thighWeight = 0;
			for (let k = 0; k < 4; k++) {
				const name = byName.get(skin[o + k]);
				if (name === "thigh_l" || name === "thigh_r") {
					side = name.endsWith("_l") ? "l" : "r";
					thighWeight += weights[o + k];
				}
			}
			if (!side || thighWeight < 0.3) continue;
			const bi = names.indexOf("thigh_" + side) * 6;
			const axisVector = [bonePos[bi + 3] - bonePos[bi], bonePos[bi + 4] - bonePos[bi + 1],
				bonePos[bi + 5] - bonePos[bi + 2]];
			const length = Math.hypot(...axisVector) || 1;
			const along = ((rest[i] - bonePos[bi]) * axisVector[0] +
				(rest[i + 1] - bonePos[bi + 1]) * axisVector[1] +
				(rest[i + 2] - bonePos[bi + 2]) * axisVector[2]) / length;
			if (along <= length * 0.5) continue;
			arr[i] = 0; arr[i + 1] = 0; arr[i + 2] = 0;
		}
	};

	const order = keys.filter((k) => targets[k]);
	for (const k of order) {
		if (k === "glutes" ||
			k === "gluteWidth" || k === "gluteHeight" || k === "stomach" || k === "thigh") {
			smoothTarget(targets[k]);
			if (k === "thigh") maskThighLowerTarget(targets[k]);
		}
		const a = targets[k];
		for (let j = 0; j < a.length; j++) verts[j] += a[j];
	}

	// La relajación solo existe si hay una deformación que la necesita. Su
	// máscara es común a todos los sliders y se precalcula una sola vez.
	const relaxLobes = (passes) => {
		const copy = new Float32Array(verts.length);
		const active = [];
		for (let v = 0; v < count; v++) {
			const i = v * 3, o = v * 4;
			const x = rest[i], y = rest[i + 1], z = rest[i + 2];
			const t = (y - minY) / span;
			let regionWeight = 0;
			for (let k = 0; k < 4; k++) {
				if (C.glutes.includes(byName.get(skin[o + k]))) regionWeight += weights[o + k];
			}
			if (regionWeight < 0.3) continue;
			let fall = 0;
			if (z < -0.01 && t > 0.42 && t < 0.63) {
				const cx = (x >= 0 ? 1 : -1) * gluteX;
				const dx = (x - cx) / (0.09 * span);
				const dy = (y - gluteY) / (0.095 * span);
				const dz = (z - gluteZ) / (0.085 * span);
				const cleft = Math.min(1, Math.abs(x) / (0.022 * span));
				fall = Math.exp(-(dx * dx + dy * dy + dz * dz) * 1.2 / (1.6 * 1.6))
					* cleft * regionWeight;
			}
			const blend = Math.min(0.72, fall * 0.72);
			const ns = neighbors[v];
			if (blend >= 0.005 && ns.length) active.push({ i, blend, ns });
		}
		for (let pass = 0; pass < passes; pass++) {
			copy.set(verts);
			for (const { i, blend, ns } of active) {
				for (let axis = 0; axis < 3; axis++) {
					let sum = 0;
					for (const n of ns) sum += copy[n * 3 + axis];
					const average = sum / ns.length;
					verts[i + axis] = copy[i + axis] * (1 - blend) + average * blend;
				}
			}
		}
	};
	const gluteActive = fGlute !== 1 || fGluteWidth !== 1 || fGluteHeight !== 1;
	if (gluteActive) relaxLobes(8);

	// Corrección local de seguridad: solo los vértices de caras invertidas se
	// acercan a sus vecinos. Si un solo eje está activo, la corrección se limita
	// a ese eje para no romper la independencia XYZ.
	const untangleLobes = (maxPasses) => {
		const accepted = C.glutes;
		const triangles = [];
		const reference = rest;
		const normal = (a, ia, ib, ic) => {
			const ax = a[ia * 3], ay = a[ia * 3 + 1], az = a[ia * 3 + 2];
			const ux = a[ib * 3] - ax, uy = a[ib * 3 + 1] - ay, uz = a[ib * 3 + 2] - az;
			const vx = a[ic * 3] - ax, vy = a[ic * 3 + 1] - ay, vz = a[ic * 3 + 2] - az;
			return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
		};
		for (let j = 0; j < idx.length; j += 3) {
			const ia = idx[j], ib = idx[j + 1], ic = idx[j + 2];
			const cy = (rest[ia * 3 + 1] + rest[ib * 3 + 1] + rest[ic * 3 + 1]) / 3;
			const cz = (rest[ia * 3 + 2] + rest[ib * 3 + 2] + rest[ic * 3 + 2]) / 3;
			const t = (cy - minY) / span;
			if (!(cz < -0.01 && t > 0.42 && t < 0.63)) continue;
			let regionWeight = 0;
			for (const v of [ia, ib, ic]) {
				for (let k = 0; k < 4; k++) {
					const boneName = byName.get(skin[v * 4 + k]);
					if (accepted.includes(boneName)) regionWeight += weights[v * 4 + k];
				}
			}
			if (regionWeight < 0.15) continue;
			const n = normal(reference, ia, ib, ic);
			const length = Math.hypot(...n);
			if (length > 1e-7) triangles.push({ ia, ib, ic, n: n.map((x) => x / length) });
		}
		const activeAxes = [fGluteWidth !== 1, fGluteHeight !== 1, fGlute !== 1];
		const copy = new Float32Array(verts.length);
		const marked = new Set();
		for (let pass = 0; pass < maxPasses; pass++) {
			marked.clear();
			for (const { ia, ib, ic, n } of triangles) {
				const current = normal(verts, ia, ib, ic);
				const length = Math.hypot(...current);
				if (length < 1e-7 || current[0] * n[0] + current[1] * n[1] + current[2] * n[2] < 0) {
					marked.add(ia); marked.add(ib); marked.add(ic);
				}
			}
			if (!marked.size) break;
			copy.set(verts);
			for (const v of marked) {
				const ns = neighbors[v];
				if (!ns.length) continue;
				for (let axis = 0; axis < 3; axis++) {
					if (!activeAxes[axis]) continue;
					let sum = 0;
					for (const n of ns) sum += copy[n * 3 + axis];
					const average = sum / ns.length;
					verts[v * 3 + axis] = copy[v * 3 + axis] * 0.55 + average * 0.45;
				}
			}
		}
	};

	if (gluteActive) untangleLobes(16);
	return { order, vertices: verts, count };
}
