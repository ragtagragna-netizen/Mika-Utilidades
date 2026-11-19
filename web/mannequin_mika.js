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
	female: { shoulder: 25, bust: 23, waist: 13, hips: 28, glute: 24 },
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
const GUIDE = "rgba(17, 17, 17, 0.42)";

function fillStroke(ctx, width = 2.2) {
	ctx.fillStyle = FILL;
	ctx.fill();
	ctx.lineWidth = width;
	ctx.strokeStyle = LINE;
	ctx.stroke();
}

// Segmento cónico con contorno (muslo, pantorrilla, brazo, antebrazo).
function tapered(ctx, a, b, wa, wb, bulge = 1) {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const len = Math.hypot(dx, dy) || 1;
	const nx = -dy / len, ny = dx / len;
	const c1x = a[0] + dx * 0.28, c1y = a[1] + dy * 0.28;
	const c2x = a[0] + dx * 0.72, c2y = a[1] + dy * 0.72;
	const w1 = (wa * 0.72 + wb * 0.28) * bulge;
	const w2 = (wa * 0.3 + wb * 0.7) * bulge;
	ctx.beginPath();
	ctx.moveTo(a[0] + nx * wa, a[1] + ny * wa);
	ctx.bezierCurveTo(c1x + nx * w1, c1y + ny * w1, c2x + nx * w2, c2y + ny * w2,
		b[0] + nx * wb, b[1] + ny * wb);
	ctx.lineTo(b[0] - nx * wb, b[1] - ny * wb);
	ctx.bezierCurveTo(c2x - nx * w2, c2y - ny * w2, c1x - nx * w1, c1y - ny * w1,
		a[0] - nx * wa, a[1] - ny * wa);
	ctx.closePath();
	fillStroke(ctx);
}

function ellipse(ctx, c, r, stroke = 2.2) {
	ctx.beginPath();
	ctx.ellipse(c[0], c[1], Math.max(1, r[0]), Math.max(1, r[1]), 0, 0, Math.PI * 2);
	fillStroke(ctx, stroke);
}

function joint(ctx, p, r) {
	ctx.beginPath();
	ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
	ctx.fillStyle = FILL;
	ctx.fill();
	ctx.lineWidth = 1.1;
	ctx.strokeStyle = GUIDE;
	ctx.stroke();
}

function guideLine(ctx, a, b) {
	ctx.beginPath();
	ctx.moveTo(a[0], a[1]);
	ctx.lineTo(b[0], b[1]);
	ctx.strokeStyle = GUIDE;
	ctx.lineWidth = 1;
	ctx.stroke();
}

function drawHead(ctx, pt) {
	const [x, y] = pt.head;
	const r = pt.headRadius;
	tapered(ctx, pt.neck, [x, y + r * 0.7], 13, 10);
	ellipse(ctx, [x, y], [r * 0.82, r]);
	guideLine(ctx, [x, y - r + 2], [x, y + r - 2]);
	ctx.beginPath();
	ctx.ellipse(x, y, r * 0.82, r * 0.28, 0, 0, Math.PI);
	ctx.strokeStyle = GUIDE;
	ctx.lineWidth = 1;
	ctx.stroke();
}

function drawTorso(ctx, pt, base, m) {
	const p = m.proportions;
	const female = m.gender === "female";
	const sy = pt.shoulderL[1];
	const ny = pt.neck[1];
	const sw = base.shoulder * 0.9;
	const bust = base.bust * p.bust;
	const waist = base.waist * p.waist;
	const hip = base.hips * p.hips;
	const cy = pt.chest[1], wy = pt.waist[1], hy = pt.pelvis[1];

	ctx.beginPath();
	ctx.moveTo(-5, ny);
	ctx.bezierCurveTo(-10, ny + 2, -sw * 0.7, sy - 6, -sw, sy + 4);
	ctx.bezierCurveTo(-sw - 2, sy + 20, -bust - 6, cy - 10, -bust, cy + 2);
	ctx.bezierCurveTo(-bust + 1, cy + 18, -waist - 1, wy - 18, -waist, wy);
	ctx.bezierCurveTo(-waist, wy + 20, -hip + 3, hy - 16, -hip, hy + 2);
	ctx.bezierCurveTo(-hip * 0.7, hy + 14, hip * 0.7, hy + 14, hip, hy + 2);
	ctx.bezierCurveTo(hip - 3, hy - 16, waist, wy + 20, waist, wy);
	ctx.bezierCurveTo(waist + 1, wy - 18, bust - 1, cy + 18, bust, cy + 2);
	ctx.bezierCurveTo(bust + 6, cy - 10, sw + 2, sy + 20, sw, sy + 4);
	ctx.bezierCurveTo(sw * 0.7, sy - 6, 10, ny + 2, 5, ny);
	ctx.closePath();
	fillStroke(ctx, 2.4);

	guideLine(ctx, [0, ny + 4], [0, hy - 4]);
	guideLine(ctx, [-waist + 2, wy], [waist - 2, wy]);

	if (female) {
		ellipse(ctx, [-bust * 0.5, cy + 6], [bust * 0.55, bust * 0.46]);
		ellipse(ctx, [bust * 0.5, cy + 6], [bust * 0.55, bust * 0.46]);
	} else {
		guideLine(ctx, [-bust * 0.7, cy + 2], [bust * 0.7, cy + 2]);
	}
}

function drawHand(ctx, wrist, angle, side) {
	ctx.save();
	ctx.translate(wrist[0], wrist[1]);
	ctx.rotate(angle - Math.PI / 2);
	ctx.beginPath();
	ctx.ellipse(0, 9, 6.5, 10, 0, 0, Math.PI * 2);
	fillStroke(ctx, 1.8);
	ctx.strokeStyle = LINE;
	ctx.lineWidth = 1.4;
	for (let i = 0; i < 4; i++) {
		const x = -3.6 + i * 2.4;
		ctx.beginPath();
		ctx.moveTo(x, 15);
		ctx.lineTo(x, 20 + (i === 1 || i === 2 ? 1 : 0));
		ctx.stroke();
	}
	ctx.beginPath();
	ctx.moveTo(side === "L" ? -5 : 5, 8);
	ctx.lineTo(side === "L" ? -9 : 9, 14);
	ctx.stroke();
	ctx.restore();
}

function drawFoot(ctx, ankle, side) {
	const d = side === "L" ? -1 : 1;
	const x = ankle[0], y = ankle[1];
	ctx.beginPath();
	ctx.moveTo(x - 8, y - 2);
	ctx.bezierCurveTo(x - 10, y + 14, x - 9 + d * 5, y + 27, x - 6 + d * 7, y + 31);
	ctx.lineTo(x + 8 + d * 7, y + 31);
	ctx.bezierCurveTo(x + 10 + d * 5, y + 18, x + 9, y + 8, x + 8, y - 2);
	ctx.closePath();
	fillStroke(ctx, 2);
	ctx.strokeStyle = LINE;
	ctx.lineWidth = 1.3;
	for (let i = 0; i < 4; i++) {
		const tx = x - 5 + i * 3.4 + d * 5;
		ctx.beginPath();
		ctx.moveTo(tx, y + 30);
		ctx.lineTo(tx, y + 36);
		ctx.stroke();
	}
}

function anatomy(ctx, m, p, pt) {
	const y = pt.pelvis[1];
	if (m.gender === "female") {
		ellipse(ctx, [pt.pelvis[0], y + 20], [7 * p.genitalSize, 11 * p.genitalSize]);
		ellipse(ctx, [pt.pelvis[0], y + 21], [3.2 * p.openingSize, 6 * p.openingSize]);
	} else {
		const g = p.genitalSize;
		ellipse(ctx, [pt.pelvis[0], y + 20], [5 * g, 13 * g]);
		tapered(ctx, [pt.pelvis[0], y + 14], [pt.pelvis[0], y + 30], 5 * g, 4 * g);
	}
	ellipse(ctx, [pt.pelvis[0], y + 37], [4 * p.anusSize, 3 * p.anusSize]);
}

export function drawMannequin(ctx, m, nsfw = false) {
	if (!m || !ctx) return;
	const pt = skeleton(m);
	const base = BASE[m.gender] || BASE.female;
	ctx.save();
	ctx.lineCap = "round";
	ctx.lineJoin = "round";

	for (const side of ["L", "R"]) {
		tapered(ctx, pt["hip" + side], pt["knee" + side], 15.5, 6.5, 1.04);
		tapered(ctx, pt["knee" + side], pt["ankle" + side], 6.5, 4.8, 1.08);
		drawFoot(ctx, pt["ankle" + side], side);
	}
	for (const side of ["L", "R"]) {
		tapered(ctx, pt["shoulder" + side], pt["elbow" + side], 11.5, 7.5, 1.1);
		tapered(ctx, pt["elbow" + side], pt["wrist" + side], 7, 5, 1.15);
		drawHand(ctx, pt["wrist" + side], pt["wristAngle" + side], side);
	}

	drawTorso(ctx, pt, base, m);
	drawHead(ctx, pt);

	for (const side of ["L", "R"]) {
		joint(ctx, pt["shoulder" + side], 3.6);
		joint(ctx, pt["elbow" + side], 3);
		joint(ctx, pt["knee" + side], 2);
		joint(ctx, pt["ankle" + side], 3);
	}
	joint(ctx, pt.neck, 2.6);

	if (nsfw) anatomy(ctx, m, m.proportions, pt);
	ctx.restore();
}

function handleSizeFallback(m) {
	return Math.max(3, Math.abs(m.tf.sx) * 8);
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
