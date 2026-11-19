// Maniquí articulado — modelo, esqueleto y render 2D.
// Expuesto para el Anima Lineart Canvas-Mika. Sin dependencias.

export const GENDERS = ["female", "male"];

export const PROPORTIONS = [
	"height", "bust", "waist", "hips", "glutes",
	"armLength", "legLength", "headSize",
	"genitalSize", "openingSize", "anusSize",
];

export const JOINTS = [
	"neck", "shoulderL", "elbowL", "wristL",
	"shoulderR", "elbowR", "wristR",
	"hipL", "kneeL", "ankleL",
	"hipR", "kneeR", "ankleR",
];

const LIMITS = {
	height: [0.7, 1.4], armLength: [0.6, 1.5], legLength: [0.7, 1.4],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rad = (a) => a;

// Punto base con rotación acumulada alrededor del padre.
function rot(x, y, a) {
	const c = Math.cos(a), s = Math.sin(a);
	return [x * c - y * s, x * s + y * c];
}

const BASE = {
	female: { shoulder: 26, bust: 21, waist: 15, hips: 25, glute: 22 },
	male: { shoulder: 34, bust: 17, waist: 19, hips: 21, glute: 19 },
};

function defaults(id, index, w, h) {
	const proportions = {};
	for (const k of PROPORTIONS) proportions[k] = 1;
	const pose = {};
	for (const k of JOINTS) pose[k] = 0;
	return {
		id, name: `Maniquí ${index + 1}`, visible: true,
		tf: { cx: w / 2, cy: h / 2, sx: 1, sy: 1, rot: 0 },
		gender: "female", proportions, pose,
	};
}

export function createMannequin(id, index, w, h) {
	return defaults(id, index, w, h);
}

export function setJoint(m, joint, angle) {
	if (!m?.pose || !(joint in m.pose)) return;
	m.pose[joint] = clamp(rad(angle), -Math.PI, Math.PI);
}

export function setProportion(m, key, value) {
	if (!m?.proportions || !(key in m.proportions)) return;
	const [a, b] = LIMITS[key] || [0.6, 1.6];
	m.proportions[key] = clamp(Number(value) || a, a, b);
}

export function applyGender(m, gender) {
	if (!m) return;
	m.gender = GENDERS.includes(gender) ? gender : "female";
}

// Esqueleto en coordenadas locales (origen en la cadera).
export function skeleton(m) {
	const p = m.proportions;
	const base = BASE[m.gender] || BASE.female;
	const h = p.height;
	const k = m.pose;
	const pt = {};
	const pelvis = [0, 0];
	const waist = [0, -55 * h];
	const chest = [0, -95 * h];
	const neck = [0, -120 * h];
	const head = [neck[0] + rot(0, -32 * p.headSize, k.neck)[0],
		neck[1] + rot(0, -32 * p.headSize, k.neck)[1]];

	pt.pelvis = pelvis;
	pt.waist = waist;
	pt.chest = chest;
	pt.neck = neck;
	pt.head = head;
	pt.headRadius = 24 * p.headSize;
	pt.chestR = [base.bust * p.bust, 16 * p.bust];
	pt.waistR = [base.waist * p.waist, 12 * p.waist];
	pt.hipR = [base.hips * p.hips, 15 * p.hips];
	pt.gluteR = [base.glute * p.glutes, 14 * p.glutes];

	for (const side of ["L", "R"]) {
		const s = side === "L" ? -1 : 1;
		const shoulder = [chest[0] + s * base.shoulder, chest[1] - 4 * h];
		const a1 = k["shoulder" + side];
		const elbow = [shoulder[0] + rot(s * 8, 68 * p.armLength, a1)[0],
			shoulder[1] + rot(s * 8, 68 * p.armLength, a1)[1]];
		const a2 = a1 + k["elbow" + side];
		const wrist = [elbow[0] + rot(s * 6, 62 * p.armLength, a2)[0],
			elbow[1] + rot(s * 6, 62 * p.armLength, a2)[1]];
		pt["shoulder" + side] = shoulder;
		pt["elbow" + side] = elbow;
		pt["wrist" + side] = wrist;
		pt["wristAngle" + side] = a2 + k["wrist" + side];

		const hip = [pelvis[0] + s * 15, pelvis[1]];
		const a3 = k["hip" + side];
		const knee = [hip[0] + rot(s * 4, 74 * p.legLength, a3)[0],
			hip[1] + rot(s * 4, 74 * p.legLength, a3)[1]];
		const a4 = a3 + k["knee" + side];
		const ankle = [knee[0] + rot(s * 2, 72 * p.legLength, a4)[0],
			knee[1] + rot(s * 2, 72 * p.legLength, a4)[1]];
		pt["hip" + side] = hip;
		pt["knee" + side] = knee;
		pt["ankle" + side] = ankle;
		pt["ankleAngle" + side] = a4 + k["ankle" + side];
	}
	return pt;
}

const LINE = "#111";
const FILL = "#ddd";

function limb(ctx, a, b, width) {
	ctx.beginPath();
	ctx.moveTo(a[0], a[1]);
	ctx.lineTo(b[0], b[1]);
	ctx.lineWidth = width + 3;
	ctx.strokeStyle = LINE;
	ctx.stroke();
	ctx.lineWidth = width;
	ctx.strokeStyle = FILL;
	ctx.stroke();
}

function ellipse(ctx, c, r) {
	ctx.beginPath();
	ctx.ellipse(c[0], c[1], Math.max(1, r[0]), Math.max(1, r[1]), 0, 0, Math.PI * 2);
	ctx.fillStyle = FILL;
	ctx.fill();
	ctx.lineWidth = 2.5;
	ctx.strokeStyle = LINE;
	ctx.stroke();
}

function anatomy(ctx, m, p, pt) {
	const y = pt.pelvis[1];
	if (m.gender === "female") {
		ellipse(ctx, [pt.pelvis[0], y + 20],
			[7 * p.genitalSize, 11 * p.genitalSize]);
		ellipse(ctx, [pt.pelvis[0], y + 21],
			[3.2 * p.openingSize, 6 * p.openingSize]);
	} else {
		const g = p.genitalSize;
		ellipse(ctx, [pt.pelvis[0], y + 20], [5 * g, 13 * g]);
		limb(ctx, [pt.pelvis[0], y + 14], [pt.pelvis[0], y + 30], 8 * g);
	}
	ellipse(ctx, [pt.pelvis[0], y + 37], [4 * p.anusSize, 3 * p.anusSize]);
}

export function drawMannequin(ctx, m) {
	if (!m || !ctx) return;
	const pt = skeleton(m);
	ctx.save();
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	for (const side of ["L", "R"]) {
		limb(ctx, pt["hip" + side], pt["knee" + side], 15);
		limb(ctx, pt["knee" + side], pt["ankle" + side], 11);
	}
	for (const side of ["L", "R"]) {
		limb(ctx, pt["shoulder" + side], pt["elbow" + side], 12);
		limb(ctx, pt["elbow" + side], pt["wrist" + side], 9);
	}
	limb(ctx, pt.pelvis, pt.neck, 34);

	ellipse(ctx, pt.pelvis, pt.hipR);
	ellipse(ctx, [0, pt.pelvis[1] + 8], pt.gluteR);
	ellipse(ctx, pt.waist, pt.waistR);
	ellipse(ctx, pt.chest, pt.chestR);
	ellipse(ctx, pt.head, [pt.headRadius, pt.headRadius]);

	anatomy(ctx, m, m.proportions, pt);
	ctx.restore();
}

export function mannequinBounds(m) {
	const pt = skeleton(m);
	const pts = [pt.head, pt.neck, pt.pelvis];
	for (const side of ["L", "R"]) {
		pts.push(pt["shoulder" + side], pt["elbow" + side], pt["wrist" + side]);
		pts.push(pt["hip" + side], pt["knee" + side], pt["ankle" + side]);
	}
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [x, y] of pts) {
		x0 = Math.min(x0, x); x1 = Math.max(x1, x);
		y0 = Math.min(y0, y); y1 = Math.max(y1, y);
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function localPoint(m, x, y) {
	const t = m.tf;
	const dx = x - t.cx, dy = y - t.cy;
	const c = Math.cos(-t.rot), s = Math.sin(-t.rot);
	return [(dx * c - dy * s) / (t.sx || 1), (dx * s + dy * c) / (t.sy || 1)];
}

export function jointHit(m, x, y, radius) {
	if (!m) return null;
	const pt = skeleton(m);
	for (const j of JOINTS) {
		const q = pt[j];
		if (q && Math.hypot(x - q[0], y - q[1]) <= radius) return j;
	}
	return null;
}

export function serializeMannequins(list) {
	return (list || []).map((m) => JSON.parse(JSON.stringify(m)));
}

export function deserializeMannequins(data, w, h) {
	return (Array.isArray(data) ? data : []).map((raw, i) => {
		const m = defaults(raw.id || `M${i}`, i, w, h);
		if (raw.gender) m.gender = raw.gender;
		if (raw.name) m.name = raw.name;
		if (raw.visible !== undefined) m.visible = !!raw.visible;
		if (raw.tf) m.tf = { ...m.tf, ...raw.tf };
		if (raw.proportions) {
			for (const k of PROPORTIONS) {
				if (raw.proportions[k] !== undefined) m.proportions[k] = raw.proportions[k];
			}
		}
		if (raw.pose) {
			for (const k of JOINTS) {
				if (raw.pose[k] !== undefined) m.pose[k] = raw.pose[k];
			}
		}
		return m;
	});
}
