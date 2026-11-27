// Ancla de primera persona derivada de los landmarks del modelo final. Se
// parents a la cabeza en bind y hereda edad, tamaño, poses y desplazamientos.

import * as THREE from "./vendor/three/three.module.js";

function landmarkPoint(character, name) {
	const indices = character.solved.landmarkIndices?.[name];
	if (!indices?.length) return null;
	const positions = character.mesh.geometry.attributes.position.array;
	const point = new THREE.Vector3();
	let count = 0;
	for (const index of indices) {
		if (index * 3 + 2 >= positions.length) continue;
		point.add(new THREE.Vector3(...positions.slice(index * 3, index * 3 + 3)));
		count++;
	}
	return count ? point.multiplyScalar(1 / count) : null;
}

export function createPovAnchor(character) {
	const head = character.byName.head;
	const left = landmarkPoint(character, "left_eye");
	const right = landmarkPoint(character, "right_eye");
	const nose = landmarkPoint(character, "nose");
	if (!head || !left || !right || !nose) return null;
	const eyes = left.add(right).multiplyScalar(0.5);
	const forward = nose.clone().sub(eyes).normalize();
	const distance = eyes.distanceTo(nose);
	const position = eyes.clone().addScaledVector(forward, distance * 0.35);
	const up = new THREE.Vector3(0, 1, 0);
	const quaternion = new THREE.Quaternion().setFromRotationMatrix(
		new THREE.Matrix4().lookAt(position, position.clone().add(forward), up));

	character.group.updateMatrixWorld(true);
	const localPosition = head.worldToLocal(position.clone());
	const localQuaternion = head.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(quaternion);
	const anchor = new THREE.Object3D();
	anchor.name = "mika_pov_eyes";
	anchor.position.copy(localPosition);
	anchor.quaternion.copy(localQuaternion);
	anchor.userData.near = Math.max(0.003, distance * 0.025);
	head.add(anchor);
	return anchor;
}

export function updatePovCamera(camera, anchor) {
	if (!anchor) return;
	anchor.updateWorldMatrix(true, false);
	anchor.getWorldPosition(camera.position);
	anchor.getWorldQuaternion(camera.quaternion);
	camera.near = anchor.userData.near || 0.005;
	camera.far = 2000;
	camera.updateProjectionMatrix();
}
