// Correctores locales de hombro para el skinning lineal de MakeHuman.
// Se calculan dos poses canónicas por lado y se interpolan sus influencias;
// el shader, los pesos y la geometría de reposo permanecen intactos.

import * as THREE from "./vendor/three/three.module.js";

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function weightedBoneMatrix(mesh, skinIndices, skinWeights, vertex) {
	const result = new THREE.Matrix4();
	result.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
	const o = vertex * 4;
	for (let k = 0; k < 4; k++) {
		const weight = skinWeights[o + k];
		if (!weight) continue;
		const bone = skinIndices[o + k];
		const matrix = new THREE.Matrix4().multiplyMatrices(
			mesh.skeleton.bones[bone].matrixWorld,
			mesh.skeleton.boneInverses[bone],
		);
		for (let j = 0; j < 16; j++) result.elements[j] += matrix.elements[j] * weight;
	}
	return result;
}

function linearDelta(matrix, delta) {
	const e = matrix.elements;
	return new THREE.Vector3(
		e[0] * delta.x + e[4] * delta.y + e[8] * delta.z,
		e[1] * delta.x + e[5] * delta.y + e[9] * delta.z,
		e[2] * delta.x + e[6] * delta.y + e[10] * delta.z,
	);
}

function shoulderSides(character, pack) {
	const names = pack.bones.map((bone) => bone.name);
	const result = {};
	for (const side of ["l", "r"]) {
		const index = names.indexOf("upperarm_" + side);
		const bone = character.byName["upperarm_" + side];
		const child = character.byName["lowerarm_" + side];
		if (index < 0 || !bone || !child) continue;
		const o = index * 6;
		const positions = character.solved.bonePositions;
		const restDirection = new THREE.Vector3(
			positions[o + 3] - positions[o],
			positions[o + 4] - positions[o + 1],
			positions[o + 5] - positions[o + 2],
		).normalize();
		const length = Math.hypot(
			positions[o + 3] - positions[o],
			positions[o + 4] - positions[o + 1],
			positions[o + 5] - positions[o + 2],
		);
		const targetDirection = new THREE.Vector3(side === "l" ? 0.15 : -0.15, 1, 0).normalize();
		result[side] = { bone, child, restDirection, targetDirection, length };
	}
	return result;
}

function relaxCanonicalShoulder(records, indices) {
	const byVertex = new Map(records.map((record) => [record.v, record]));
	const triangles = [];
	for (let i = 0; i < indices.length; i += 3) {
		const ids = [indices[i], indices[i + 1], indices[i + 2]];
		if (ids.every((v) => byVertex.has(v))) triangles.push(ids);
	}
	const constraints = [];
	for (const ids of triangles) {
		const [a, b, c] = ids.map((v) => byVertex.get(v).rest);
		const restArea = new THREE.Vector3().subVectors(b, a)
			.cross(new THREE.Vector3().subVectors(c, a)).length() * 0.5;
		if (restArea > 1e-8) constraints.push({ ids, restArea });
	}
	for (let pass = 0; pass < 32; pass++) {
		for (const { ids } of constraints) {
			for (let k = 0; k < 3; k++) {
				const ra = byVertex.get(ids[k]);
				const rb = byVertex.get(ids[(k + 1) % 3]);
				const restLength = ra.rest.distanceTo(rb.rest);
				if (restLength < 1e-7) continue;
				const delta = new THREE.Vector3().subVectors(rb.desired, ra.desired);
				const length = delta.length();
				const maxLength = restLength * 2.3;
				if (length <= maxLength || length < 1e-7) continue;
				delta.multiplyScalar((length - maxLength) / length * 0.5);
				ra.desired.add(delta);
				rb.desired.sub(delta);
			}
		}
		for (const { ids, restArea } of constraints) {
			const [a, b, c] = ids.map((v) => byVertex.get(v));
			const normal = new THREE.Vector3().subVectors(b.desired, a.desired)
				.cross(new THREE.Vector3().subVectors(c.desired, a.desired));
			const twiceArea = normal.length();
			const targetTwice = restArea * 0.8; // área mínima 0.40
			if (twiceArea >= targetTwice || twiceArea < 1e-9) continue;
			normal.multiplyScalar(1 / twiceArea);
			const ga = new THREE.Vector3().subVectors(b.desired, c.desired).cross(normal).multiplyScalar(0.5);
			const gb = new THREE.Vector3().subVectors(c.desired, a.desired).cross(normal).multiplyScalar(0.5);
			const gc = new THREE.Vector3().subVectors(a.desired, b.desired).cross(normal).multiplyScalar(0.5);
			const denominator = ga.lengthSq() + gb.lengthSq() + gc.lengthSq();
			if (denominator < 1e-10) continue;
			const scale = Math.min(0.08, (targetTwice - twiceArea) / denominator);
			a.desired.addScaledVector(ga, scale);
			b.desired.addScaledVector(gb, scale);
			c.desired.addScaledVector(gc, scale);
		}
	}
}

export function attachShoulderCorrectives(character, pack, staticData, cached = null) {
	const { mesh, outline, group } = character;
	const sides = shoulderSides(character, pack);
	const geometry = mesh.geometry;
	const positions = geometry.attributes.position.array;
	const skinIndices = staticData.skinIndices;
	const skinWeights = staticData.skinWeights;
	const names = pack.bones.map((bone) => bone.name);
	const levels = [
		{ key: "middle", fraction: 0.55 },
		{ key: "raised", fraction: 1 },
	];
	const source = [];
	for (let v = 0; v < positions.length / 3; v++) {
		let upperWeight = 0;
		for (let k = 0; k < 4; k++) {
			const name = names[skinIndices[v * 4 + k]];
			if (name === "upperarm_l" || name === "upperarm_r") upperWeight += skinWeights[v * 4 + k];
		}
		if (upperWeight < 0.04) continue;
		source.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
	}
	for (let i = 0; i < names.length; i++) {
		if (!/^(spine_|clavicle_|upperarm_|lowerarm_)/.test(names[i])) continue;
		for (let axis = 0; axis < 6; axis++) {
			source.push(character.solved.bonePositions[i * 6 + axis]);
		}
	}
	const reuse = cached?.source?.length === source.length &&
		source.every((value, index) => Math.abs(value - cached.source[index]) <= 0.05);
	const arrays = reuse ? cached.arrays : Object.fromEntries(levels.map(({ key }) => [key, {
		l: new Float32Array(positions.length),
		r: new Float32Array(positions.length),
	}]));
	if (!reuse) {
		const original = new Map();
		for (const side of Object.keys(sides)) {
			original.set(side, sides[side].bone.quaternion.clone());
		}

		group.updateMatrixWorld(true);
		for (const side of Object.keys(sides)) {
			const data = sides[side];
			const worldDelta = new THREE.Quaternion().setFromUnitVectors(
				data.restDirection, data.targetDirection);
			const parent = data.bone.parent.getWorldQuaternion(new THREE.Quaternion());
			data.delta = parent.clone().invert().multiply(worldDelta).multiply(parent);
		}

		for (const level of levels) {
			for (const side of Object.keys(sides)) {
				sides[side].bone.quaternion.identity().slerp(sides[side].delta, level.fraction);
			}
			group.updateMatrixWorld(true);
			mesh.skeleton.update();
			const records = { l: [], r: [] };
			for (let v = 0; v < positions.length / 3; v++) {
				const o = v * 4;
				let side = null;
				let upperWeight = 0;
				for (let k = 0; k < 4; k++) {
					const name = names[skinIndices[o + k]];
					if (name === "upperarm_l" || name === "upperarm_r") {
						side = name.endsWith("_l") ? "l" : "r";
						upperWeight += skinWeights[o + k];
					}
				}
				if (!side || !sides[side] || upperWeight < 0.04) continue;
				const data = sides[side];
				const boneIndex = names.indexOf("upperarm_" + side) * 6;
				const bp = character.solved.bonePositions;
				const point = new THREE.Vector3(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
				const along = point.clone().sub(new THREE.Vector3(
					bp[boneIndex], bp[boneIndex + 1], bp[boneIndex + 2])).dot(data.restDirection);
				if (along < -0.35 * data.length || along > 0.55 * data.length) continue;

				const skin = weightedBoneMatrix(mesh, skinIndices, skinWeights, v);
				const localSkin = new THREE.Matrix4().multiplyMatrices(mesh.bindMatrixInverse, skin)
					.multiply(mesh.bindMatrix);
				const linear = mesh.getVertexPosition(v, new THREE.Vector3());
				records[side].push({ v, rest: point, linear, desired: linear.clone(), localSkin });
			}
			for (const side of Object.keys(records)) {
				relaxCanonicalShoulder(records[side], geometry.index.array);
				for (const record of records[side]) {
					const correction = linearDelta(record.localSkin.invert(),
						record.desired.clone().sub(record.linear));
					if (!Number.isFinite(correction.x + correction.y + correction.z)) continue;
					arrays[level.key][side].set([correction.x, correction.y, correction.z], record.v * 3);
				}
			}
		}

		for (const [side, quaternion] of original) sides[side].bone.quaternion.copy(quaternion);
		group.updateMatrixWorld(true);
		mesh.skeleton.update();
	}

	geometry.morphAttributes.position = [];
	for (const { key } of levels) {
		for (const side of ["l", "r"]) {
			geometry.morphAttributes.position.push(
				new THREE.Float32BufferAttribute(arrays[key][side], 3));
		}
	}
	geometry.morphTargetsRelative = true;
	mesh.updateMorphTargets();
	outline.updateMorphTargets();

	const currentDirection = new THREE.Vector3();
	const origin = new THREE.Vector3();
	const inverseGroupRotation = new THREE.Quaternion();
	const update = () => {
		group.getWorldQuaternion(inverseGroupRotation).invert();
		const influences = [];
		for (const side of ["l", "r"]) {
			const data = sides[side];
			let middle = 0;
			let raised = 0;
			if (data) {
				data.bone.getWorldPosition(origin);
				data.child.getWorldPosition(currentDirection).sub(origin).normalize()
					.applyQuaternion(inverseGroupRotation);
				const restDot = Math.max(-1, Math.min(1, data.restDirection.dot(data.targetDirection)));
				const currentDot = Math.max(-1, Math.min(1, data.restDirection.dot(currentDirection)));
				const fullAngle = Math.acos(restDot);
				const angle = Math.acos(currentDot);
				const fraction = clamp01(angle / Math.max(0.001, fullAngle));
				if (fraction <= 0.55) middle = fraction / 0.55;
				else {
					raised = (fraction - 0.55) / 0.45;
					middle = 1 - raised;
				}
			}
			influences.push(middle, raised);
		}
		// El orden de atributos es middle_l, middle_r, raised_l, raised_r.
		const ordered = [influences[0], influences[2], influences[1], influences[3]];
		for (let i = 0; i < 4; i++) {
			mesh.morphTargetInfluences[i] = ordered[i];
			outline.morphTargetInfluences[i] = ordered[i];
		}
	};
	update();
	return { update, source, arrays, reused: reuse };
}
