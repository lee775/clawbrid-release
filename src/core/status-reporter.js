/**
 * 상태 리포팅 모듈 - 각 Bridge에서 사용
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

class StatusReporter {
  constructor(name) {
    this.name = name;
    this.filePath = path.join(config.STATUS_DIR, `${name}.json`);
    this.state = {
      name,
      pid: process.pid,
      active: false,
      currentMessage: '',
      user: '',
      channel: '',
      startTime: null,
      elapsedSec: 0,
      lastUpdate: new Date().toISOString(),
      history: [],
    };

    config.ensureDirs();
    this._write();

    this._ticker = setInterval(() => {
      if (this.state.active && this.state.startTime) {
        this.state.elapsedSec = Math.floor((Date.now() - new Date(this.state.startTime).getTime()) / 1000);
        this.state.lastUpdate = new Date().toISOString();
        this._write();
      }
    }, 1000);
  }

  start(message, user = '', channel = '') {
    this.state.active = true;
    this.state.currentMessage = message.length > 200 ? message.slice(0, 200) + '...' : message;
    this.state.user = user;
    this.state.channel = channel;
    this.state.startTime = new Date().toISOString();
    this.state.elapsedSec = 0;
    this.state.lastUpdate = new Date().toISOString();
    this._write();
  }

  done(responsePreview = '') {
    this.state.history.unshift({
      message: this.state.currentMessage,
      user: this.state.user,
      startTime: this.state.startTime,
      duration: this.state.elapsedSec,
      response: responsePreview.length > 150 ? responsePreview.slice(0, 150) + '...' : responsePreview,
      completedAt: new Date().toISOString(),
    });
    if (this.state.history.length > 10) {
      this.state.history = this.state.history.slice(0, 10);
    }
    this.state.active = false;
    this.state.currentMessage = '';
    this.state.user = '';
    this.state.channel = '';
    this.state.startTime = null;
    this.state.elapsedSec = 0;
    this.state.lastUpdate = new Date().toISOString();
    this._write();
  }

  error(errMsg) {
    this.done(`[ERROR] ${errMsg}`);
  }

  _write() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch { /* ignore */ }
  }

  destroy() {
    if (this._ticker) clearInterval(this._ticker);
  }
}

module.exports = StatusReporter;
