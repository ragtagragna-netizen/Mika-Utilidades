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
	bust: ["spine_03", "clavicle_l", "clavicle_r"],
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

export function buildCustomMorphs(pack, solved, staticData, params = {}) {
	const verts = solved.vertices;
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
	const LEG_SET = boneSet(["thigh_", "calf_", "foot_", "ball_"]);
	const HAND_SET = boneSet(["hand_", "index_", "middle_", "ring_", "pinky_", "thumb_"]);
	const FOOT_SET = boneSet(["foot_", "ball_"]);

	let minY = Infinity;
	let maxY = -Infinity;
	for (let i = 1; i < verts.length; i += 3) {
		minY = Math.min(minY, verts[i]);
		maxY = Math.max(maxY, verts[i]);
	}
	const span = Math.max(0.001, maxY - minY);
	const pubisY = minY + 0.53 * span;
	// Centros medidos sobre el asset en reposo (breast peak ≈ [±0.6, 1.19, 1.5],
	// glute peak ≈ [±0.36, -1.32, -0.75]); se guardan en fracciones de la altura
	// para que sigan al cuerpo cuando cambian gender/weight/altura nativa.
	const bustY = minY + 0.70 * span;
	const bustX = 0.045 * span;
	const bustZ = 0.05 * span;
	const gluteY = minY + 0.52 * span;
	const gluteX = 0.033 * span;
	const gluteZ = -0.025 * span;

	const keys = ["waist", "stomach", "hips", "glutes", "bust", "arm", "thigh",
		"calf", "armLength", "legLength", "pubis", "height", "width",
		"handSize", "footSize", "penisRot"];
	const targets = {};
	for (const k of keys) targets[k] = new Float32Array(verts.length);
	const delta = (k, i, x, y, z) => {
		const a = targets[k];
		a[i] += x;
		a[i + 1] += y;
		a[i + 2] += z;
	};

	const d = params.localDeform || {};
	const rotX = (d.penisRotX ?? 0) * Math.PI / 180;
	const rotY = (d.penisRotY ?? 0) * Math.PI / 180;
	const rotZ = (d.penisRotZ ?? 0) * Math.PI / 180;
	// Por encima de 1 el target procedural sigue al morph nativo: en 2.5 el
	// largo llega a ×1.5 y el grosor a ×3, medidos desde el ancla.
	const lenExtra = Math.max(0, (d.penisLength ?? 0.5) - 1);
	const girthExtra = Math.max(0, (d.penisGirth ?? 0.5) - 1);
	const fLen = 1 + lenExtra / 3;
	const fGirth = 1 + girthExtra * 4 / 3;
	const fWaist = 1 + (0.5 - (d.waist ?? 0.5)) * 0.45;
	const fStomach = 1 + ((d.stomach ?? 0.5) - 0.5) * 0.65;
	const fHand = 1 + ((d.handSize ?? 0.5) - 0.5) * 0.6;
	const fFoot = 1 + ((d.footSize ?? 0.5) - 0.5) * 0.6;
	const fHips = 1 + ((d.hips ?? 0.5) - 0.5) * 0.4;
	const fGlute = 1 + ((d.glutes ?? 0.5) - 0.5) * 0.85;
	const raw = params.rawAnatomy || {};
	const fBust = 1 + Math.min(3.4, Math.max(0, (raw.bust ?? 0.5) - 1) * 1.4);
	const fArm = 1 + ((d.armThickness ?? 0.5) - 0.5) * 0.5;
	const fThigh = 1 + ((d.thighThickness ?? 0.5) - 0.5) * 0.5;
	const fCalf = 1 + ((d.calfThickness ?? 0.5) - 0.5) * 0.5;
	const fArmLen = 1 + ((d.armLength ?? 0.5) - 0.5) * 0.55;
	const fLegLen = 1 + ((d.legLength ?? 0.5) - 0.5) * 0.55;
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

			if (C.waist.includes(name) && t > 0.55 && t < 0.72) {
				const fall = smooth((Math.abs(t - 0.63) - 0.025) / 0.07) * w;
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
					(z - bz) * (bellyF - 1) * 1.35 * fall);
			}

			if (C.hips.includes(name) && fHips !== 1) {
				// Campana asimétrica: ensancha al máximo en el trocánter (t≈0.48),
				// se estrecha hacia la cintura y baja suavemente por el muslo.
				// Un único campo continuo evita el óvalo con borde que daban las
				// dos bandas independientes.
				const center = 0.48;
				const sigma = t < center ? 0.14 : 0.1;
				const fall = Math.exp(-(((t - center) / sigma) ** 2)) * w;
				delta("hips", i,
					x * (fHips - 1) * fall, 0,
					z * (fHips - 1) * 0.32 * fall);
			}

			if (C.bust.includes(name) && z > 0.1 && t > 0.62 && t < 0.86 && fBust !== 1) {
				const cx = (x >= 0 ? 1 : -1) * bustX;
				const dx = (x - cx) / (0.075 * span);
				const dy = (y - bustY) / (0.075 * span);
				const dz = (z - bustZ) / (0.085 * span);
				const r2 = dx * dx + dy * dy + dz * dz;
				// La campana se ensancha con el pecho: así un seno muy grande
				// escala como una esfera y no como un pico ni un "ala".
				const widen = 1 + (fBust - 1) * 0.28;
				const fall = Math.exp(-r2 * 1.25 / (widen * widen))
					* Math.min(1, z / (0.02 * span)) * w;
				delta("bust", i,
					(x - cx) * (fBust - 1) * fall,
					(y - bustY) * (fBust - 1) * 0.7 * fall,
					(z - bustZ) * (fBust - 1) * 1.15 * fall);
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

			if (C.thigh.includes(name) && fThigh !== 1) {
				const a = axis(skin[o + k]);
				let dx = a.tx - a.hx, dy = a.ty - a.hy, dz = a.tz - a.hz;
				const len = Math.hypot(dx, dy, dz) || 1;
				dx /= len; dy /= len; dz /= len;
				const px = x - a.hx, py = y - a.hy, pz = z - a.hz;
				const along = px * dx + py * dy + pz * dz;
				delta("thigh", i,
					(px - dx * along) * (fThigh - 1) * w,
					(py - dy * along) * (fThigh - 1) * w,
					(pz - dz * along) * (fThigh - 1) * w);
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
		if (fArmLen !== 1 || fLegLen !== 1) {
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
			stretchLimb("legLength", "thigh_", fLegLen, LEG_SET);
		}

		// Glúteos: dos lóbulos redondeados en lugar de una banda plana. Cada
		// mejilla crece desde su propio centro (eje Z hacia atrás, algo de X y
		// Y) con una campana que se ensancha al exagerar, y un pliegue central
		// para que no se fundan en una sola masa.
		if (fGlute !== 1 && z < -0.01 && t > 0.42 && t < 0.63) {
			let wg = 0;
			for (let k = 0; k < 4; k++) {
				if (C.glutes.includes(byName.get(skin[o + k]))) wg += weights[o + k];
			}
			if (wg > 0.01) {
				const cx = (x >= 0 ? 1 : -1) * gluteX;
				const dx = (x - cx) / (0.065 * span);
				const dy = (y - gluteY) / (0.07 * span);
				const dz = (z - gluteZ) / (0.055 * span);
				const r2 = dx * dx + dy * dy + dz * dz;
				const widen = 1 + (fGlute - 1) * 0.3;
				const cleft = Math.min(1, Math.abs(x) / (0.022 * span));
				const fall = Math.exp(-r2 * 1.2 / (widen * widen)) * cleft * wg;
				delta("glutes", i,
					(x - cx) * (fGlute - 1) * 0.45 * fall,
					(y - gluteY) * (fGlute - 1) * 0.35 * fall,
					(z - gluteZ) * (fGlute - 1) * 1.6 * fall);
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
		// Solo las zonas con lóbulos (glúteos, caderas, estómago) se suavizan
		// un par de anillos: quita las líneas de costura al exagerar sin
		// propagar el target a todo el cuerpo.
		if (k === "glutes" || k === "hips" || k === "stomach") {
			smoothTarget(targets[k]);
		}
		const a = targets[k];
		for (let j = 0; j < a.length; j++) verts[j] += a[j];
	}
	return { order, vertices: verts, count };
}
