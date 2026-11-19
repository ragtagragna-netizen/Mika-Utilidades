// Genera targets de morph por parte del cuerpo, como los que usan MakeHuman,
// COM3D2 o Character Creator: cada target guarda SOLO el desplazamiento de los
// vértices de esa zona y el slider mezcla targets. La pertenencia se toma de los
// pesos de piel del propio rig (skinIndex/skinWeight) y el engrosamiento se
// calcula en el eje real de cada hueso, nunca en ejes globales.

const C = {
	waist: ["spine_01", "spine_02"],
	hips: ["pelvis", "thigh_l", "thigh_r"],
	glutes: ["pelvis", "thigh_l", "thigh_r"],
	bust: ["spine_03", "clavicle_l", "clavicle_r"],
	arm: ["upperarm_l", "upperarm_r", "lowerarm_l", "lowerarm_r", "hand_l", "hand_r"],
	leg: ["thigh_l", "thigh_r", "calf_l", "calf_r", "foot_l", "foot_r"],
	pubis: ["pelvis"],
};

const smooth = (d) => {
	const t = Math.max(0, Math.min(1, d));
	return (1 - t * t) * (1 - t * t);
};

export function buildCustomMorphs(pack, solved, staticData, params = {}) {
	const verts = solved.vertices;
	const count = verts.length / 3;
	const skin = staticData.skinIndices;
	const weights = staticData.skinWeights;
	const names = pack.bones.map((b) => b.name);
	const bonePos = solved.bonePositions;
	const byName = new Map(names.map((n, i) => [i, n]));

	let minY = Infinity;
	let maxY = -Infinity;
	for (let i = 1; i < verts.length; i += 3) {
		minY = Math.min(minY, verts[i]);
		maxY = Math.max(maxY, verts[i]);
	}
	const span = Math.max(0.001, maxY - minY);
	const chestY = minY + 0.73 * span;
	const hipY = minY + 0.54 * span;
	const pubisY = minY + 0.53 * span;

	const keys = ["waist", "hips", "glutes", "bust", "arm", "leg", "pubis", "height"];
	const targets = {};
	for (const k of keys) targets[k] = new Float32Array(verts.length);
	const delta = (k, i, x, y, z) => {
		const a = targets[k];
		a[i] += x;
		a[i + 1] += y;
		a[i + 2] += z;
	};

	const d = params.localDeform || {};
	const fWaist = 1 + (0.5 - (d.waist ?? 0.5)) * 0.45;
	const fHips = 1 + ((d.hips ?? 0.5) - 0.5) * 0.4;
	const fGlute = 1 + ((d.glutes ?? 0.5) - 0.5) * 0.5;
	const raw = params.rawAnatomy || {};
	const fBust = 1 + Math.min(0.8, Math.max(0, (raw.bust ?? 0.5) - 1) * 0.45);
	const fArm = 1 + ((d.armThickness ?? 0.5) - 0.5) * 0.5;
	const fLeg = 1 + ((d.legThickness ?? 0.5) - 0.5) * 0.5;
	const fPubis = 1 + ((d.genitalSize ?? 0.5) - 0.5) * 0.35;
	const h = d.height ?? 0.5;
	const fHeight = h < 0 || h > 1 ? 1 + (h - 0.5) * 0.6 : 1;

	// Eje de cada hueso (cabeza -> cola) en espacio de malla.
	const axis = (index) => {
		const o = index * 6;
		return {
			hx: bonePos[o], hy: bonePos[o + 1], hz: bonePos[o + 2],
			tx: bonePos[o + 3], ty: bonePos[o + 4], tz: bonePos[o + 5],
		};
	};
	const sideOf = (name) => (name.endsWith("_l") ? -1 : name.endsWith("_r") ? 1 : 0);

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
			const s = sideOf(name);

			if (C.waist.includes(name) && t > 0.55 && t < 0.72) {
				const fall = smooth((Math.abs(t - 0.63) - 0.025) / 0.07) * w;
				delta("waist", i, x * (fWaist - 1) * fall, 0, z * (fWaist - 1) * fall);
			}

			if (C.hips.includes(name) && t > 0.46 && t < 0.62) {
				const fall = smooth((Math.abs(t - 0.54) - 0.02) / 0.08) * w;
				delta("hips", i, x * (fHips - 1) * fall, 0, z * (fHips - 1) * fall);
				if (z < 0) {
					const cx = s || (x >= 0 ? 0.4 : -0.4);
					delta("glutes", i,
						(x - cx) * (fGlute - 1) * fall,
						(y - hipY) * (fGlute - 1) * 0.35 * fall,
						(z + 0.65) * (fGlute - 1) * fall);
				}
			}

			if (C.bust.includes(name) && z > 0 && t > 0.64 && t < 0.84 && fBust !== 1) {
				const cx = s || (x >= 0 ? 0.6 : -0.6);
				const dx = (x - cx) / 1.0;
				const dy = (y - chestY) / 0.9;
				const dz = (z - 1.0) / 1.1;
				const r2 = dx * dx + dy * dy + dz * dz;
				const fall = Math.exp(-r2 * 1.6) * Math.min(1, z / 0.5) * w;
				delta("bust", i,
					(x - cx) * (fBust - 1) * fall,
					(y - chestY) * (fBust - 1) * 0.55 * fall,
					(z - 1.0) * (fBust - 1) * fall);
			}

			if (name === "pelvis" && z > 0 && t > 0.49 && t < 0.57) {
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

			if (C.leg.includes(name) && fLeg !== 1) {
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
				delta("leg", i, rx * (fLeg - 1) * w, ry * (fLeg - 1) * w, rz * (fLeg - 1) * w);
			}
		}

		if (fHeight !== 1) delta("height", i, 0, (y - minY) * (fHeight - 1), 0);
	}

	// Un target neutro no deforma: se descarta para no gastar slots de morph.
	for (const k of keys) {
		let any = false;
		const a = targets[k];
		for (let j = 0; j < a.length; j++) {
			if (Math.abs(a[j]) > 1e-5) { any = true; break; }
		}
		if (!any) delete targets[k];
	}

	// Suavizado con la adyacencia real de la malla: quita las costuras donde
	// cambia el hueso dominante (hombro, cadera) sin desplazar el conjunto.
	const neighbors = new Array(count);
	for (let i = 0; i < count; i++) neighbors[i] = [];
	const idx = staticData.indices;
	for (let i = 0; i < idx.length; i += 3) {
		const a = idx[i], b = idx[i + 1], c = idx[i + 2];
		neighbors[a].push(b, c);
		neighbors[b].push(a, c);
		neighbors[c].push(a, b);
	}
	const smoothTarget = (arr) => {
		const copy = new Float32Array(arr);
		for (let pass = 0; pass < 2; pass++) {
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

	const order = keys.filter((k) => targets[k]);
	for (const k of order) {
		smoothTarget(targets[k]);
		const a = targets[k];
		for (let j = 0; j < a.length; j++) verts[j] += a[j];
	}
	return { order, vertices: verts, count };
}
