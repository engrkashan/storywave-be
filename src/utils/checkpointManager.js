import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('CheckpointManager');

export class CheckpointManager {
  constructor(workflowTempDir) {
    this.manifestPath = path.join(workflowTempDir, 'manifest.json');
    this.manifest = this._loadManifest();
  }

  _loadManifest() {
    if (fs.existsSync(this.manifestPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
        logger.info(`Loaded checkpoint manifest from ${this.manifestPath}`);
        return data;
      } catch (e) {
        logger.warn(`Failed to parse manifest at ${this.manifestPath}, creating new one.`);
      }
    }
    return {};
  }

  _saveManifest() {
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2));
  }

  _ensureScene(sceneId) {
    if (!this.manifest[sceneId]) {
      this.manifest[sceneId] = {
        image: 'pending',
        render: 'pending'
      };
    }
  }

  isImageCompleted(sceneId) {
    this._ensureScene(sceneId);
    return this.manifest[sceneId].image === 'completed';
  }

  isRenderCompleted(sceneId) {
    this._ensureScene(sceneId);
    return this.manifest[sceneId].render === 'completed';
  }

  markImageRunning(sceneId) {
    this._ensureScene(sceneId);
    this.manifest[sceneId].image = 'running';
    this._saveManifest();
  }

  markImageCompleted(sceneId) {
    this._ensureScene(sceneId);
    this.manifest[sceneId].image = 'completed';
    this._saveManifest();
  }

  markImageFailed(sceneId) {
    this._ensureScene(sceneId);
    this.manifest[sceneId].image = 'failed';
    this._saveManifest();
  }

  markRenderRunning(sceneId) {
    this._ensureScene(sceneId);
    this.manifest[sceneId].render = 'running';
    this._saveManifest();
  }

  markRenderCompleted(sceneId) {
    this._ensureScene(sceneId);
    this.manifest[sceneId].render = 'completed';
    this._saveManifest();
  }

  markRenderFailed(sceneId) {
    this._ensureScene(sceneId);
    this.manifest[sceneId].render = 'failed';
    this._saveManifest();
  }
}
