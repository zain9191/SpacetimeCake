// Entry point — wires the UI and starts the render loop. Modules are loaded
// in an order where every side-effect (DOM event listeners, etc.) is set up
// once before animate() runs.
import { renderer, scene, camera } from './scene.js';
import { updateUniforms } from './cube.js';
import { orthoViews } from './orthoPreviews.js';
import { orbit } from './scene.js';
import './interactions.js';  // side effects: pointer listeners
import { wireUI } from './ui.js';

wireUI();

function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  updateUniforms();
  renderer.render(scene, camera);
  for (const v of orthoViews) {
    if (v.material) v.renderer.render(v.scene, v.camera);
  }
}
animate();

// Tiny global hook used by E2E tests to know the app finished bootstrapping.
window.__spacetimeReady = true;
