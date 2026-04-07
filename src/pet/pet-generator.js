/**
 * ClawBrid Pet System - UUID 해시 기반 펫 생성기
 * 저장 없음 - UUID가 같으면 항상 동일한 펫 생성
 */
const crypto = require('crypto');
const { execSync } = require('child_process');
const { GRADES, PETS, PERSONALITIES } = require('./pet-data');

function getMachineGuid() {
  try {
    if (process.platform === 'win32') {
      return execSync(
        'powershell -Command "(Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Cryptography).MachineGuid"',
        { encoding: 'utf-8', windowsHide: true }
      ).trim();
    }
    return crypto.randomUUID();
  } catch {
    return 'fallback-' + require('os').hostname();
  }
}

function hashSeed(guid, salt) {
  const hash = crypto.createHash('sha256').update(guid + salt).digest('hex');
  return parseInt(hash.slice(0, 8), 16);
}

function pickByWeight(items, seed) {
  const totalWeight = items.reduce((sum, i) => sum + (i.weight || 1), 0);
  let roll = seed % totalWeight;
  for (const item of items) {
    roll -= (item.weight || 1);
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}

function generatePet() {
  const guid = getMachineGuid();
  const grade = pickByWeight(GRADES, hashSeed(guid, 'grade11'));
  const pet = PETS[hashSeed(guid, 'pet1') % PETS.length];
  const personality = PERSONALITIES[hashSeed(guid, 'pers11') % PERSONALITIES.length];

  const prefixes = ['꼬마', '미니', '베이비', '리틀', '프린스', '스타', '루나', '코코', '모모', '치치', '푸푸', '나나', '두두', '보보', '하루'];
  const prefix = prefixes[hashSeed(guid, 'name11') % prefixes.length];

  return {
    id: pet.id,
    name: `${prefix} ${pet.name}`,
    emoji: pet.emoji,
    category: pet.category,
    grade: { name: grade.name, stars: grade.stars, color: grade.color },
    personality: { id: personality.id, name: personality.name, promptStyle: personality.promptStyle },
  };
}

function getPetToken() {
  try {
    const guid = getMachineGuid();
    return crypto.createHash('sha256').update(guid + 'pet-verify').digest('hex');
  } catch { return null; }
}

module.exports = { generatePet, getPetToken };
