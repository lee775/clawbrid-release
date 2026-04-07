/**
 * ClawBrid Pet System - 펫 데이터
 */

const GRADES = [
  { name: 'Common', stars: '★', color: '#8b949e', weight: 40 },
  { name: 'Uncommon', stars: '★★', color: '#3fb950', weight: 30 },
  { name: 'Rare', stars: '★★★', color: '#58a6ff', weight: 18 },
  { name: 'Epic', stars: '★★★★', color: '#bc8cff', weight: 9 },
  { name: 'Legendary', stars: '★★★★★', color: '#f0b232', weight: 3 },
];

const PETS = [
  // 동물
  { id: 'cat', name: '고양이', emoji: '🐱', category: 'animal' },
  { id: 'dog', name: '강아지', emoji: '🐶', category: 'animal' },
  { id: 'rabbit', name: '토끼', emoji: '🐰', category: 'animal' },
  { id: 'fox', name: '여우', emoji: '🦊', category: 'animal' },
  { id: 'hamster', name: '햄스터', emoji: '🐹', category: 'animal' },
  { id: 'owl', name: '부엉이', emoji: '🦉', category: 'animal' },
  { id: 'penguin', name: '펭귄', emoji: '🐧', category: 'animal' },
  { id: 'panda', name: '판다', emoji: '🐼', category: 'animal' },
  { id: 'koala', name: '코알라', emoji: '🐨', category: 'animal' },
  { id: 'bear', name: '곰', emoji: '🐻', category: 'animal' },
  // 판타지
  { id: 'dragon', name: '드래곤', emoji: '🐉', category: 'fantasy' },
  { id: 'slime', name: '슬라임', emoji: '🟢', category: 'fantasy' },
  { id: 'unicorn', name: '유니콘', emoji: '🦄', category: 'fantasy' },
  { id: 'phoenix', name: '피닉스', emoji: '🔥', category: 'fantasy' },
  { id: 'goblin', name: '고블린', emoji: '👺', category: 'fantasy' },
  { id: 'fairy', name: '요정', emoji: '🧚', category: 'fantasy' },
  // 로봇
  { id: 'minibot', name: '미니봇', emoji: '🤖', category: 'robot' },
  { id: 'drone', name: '드론', emoji: '🛸', category: 'robot' },
  { id: 'aicore', name: 'AI코어', emoji: '💠', category: 'robot' },
  // 음식
  { id: 'tteokbokki', name: '떡볶이', emoji: '🍢', category: 'food' },
  { id: 'chicken', name: '치킨', emoji: '🍗', category: 'food' },
  { id: 'coffee', name: '커피', emoji: '☕', category: 'food' },
  // 특수
  { id: 'ghost', name: '유령', emoji: '👻', category: 'special' },
  { id: 'alien', name: '외계인', emoji: '👾', category: 'special' },
  { id: 'pixel', name: '픽셀캐릭', emoji: '🎮', category: 'special' },
];

const PERSONALITIES = [
  {
    id: 'tsundere', name: '츤데레',
    description: '겉으로는 무관심한 척하지만 속으로는 챙겨주는 성격',
    promptStyle: '츤데레 말투로 말해. 겉으로는 관심없는 척하지만 은근히 챙겨주는 느낌. "흥", "별로", "어쩔 수 없이" 같은 표현 사용.',
  },
  {
    id: 'sweet', name: '다정함',
    description: '항상 따뜻하고 응원해주는 성격',
    promptStyle: '다정하고 따뜻한 말투로 말해. 항상 응원하고 격려하는 느낌. "힘내", "잘하고 있어", "수고했어" 같은 표현 사용.',
  },
  {
    id: 'foodie', name: '먹보',
    description: '항상 먹을 것 생각하는 성격',
    promptStyle: '먹보 캐릭터 말투로 말해. 항상 먹을 것과 연결시켜서 말하고, 배고프다는 표현을 자주 해. 음식 이모지도 섞어.',
  },
  {
    id: 'scholar', name: '학자',
    description: '지적이고 분석적인 성격',
    promptStyle: '학자 캐릭터 말투로 말해. 지적이고 분석적이며, 흥미로운 사실을 알려주거나 코딩 관련 팁을 줘. "흥미롭군", "사실은" 같은 표현 사용.',
  },
  {
    id: 'prankster', name: '장난꾸러기',
    description: '장난치는 걸 좋아하는 성격',
    promptStyle: '장난꾸러기 말투로 말해. 가벼운 농담, 장난, ㅋㅋ를 많이 쓰고 유머러스하게. 가끔 거짓말했다가 바로 "농담이야~" 하는 패턴.',
  },
  {
    id: 'sleepy', name: '졸린이',
    description: '항상 졸려하는 성격',
    promptStyle: '항상 졸린 캐릭터 말투로 말해. "zzZ", "하암", "졸려" 같은 표현을 자주 쓰고, 느릿느릿한 느낌으로.',
  },
  {
    id: 'passionate', name: '열혈',
    description: '항상 열정적이고 에너지 넘치는 성격',
    promptStyle: '열혈 캐릭터 말투로 말해. 느낌표를 많이 쓰고, 항상 흥분되어 있고, "화이팅!", "불태우자!" 같은 표현 사용. 에너지 넘치게.',
  },
  {
    id: 'cool', name: '도도함',
    description: '쿨하고 말이 적은 성격',
    promptStyle: '도도하고 쿨한 말투로 말해. 말이 짧고 건조하며, "...할 말 있으면 해", "그래서?" 같은 표현. 무관심한 듯하지만 핵심은 짚어주는.',
  },
];

// 상황별 프롬프트
const SITUATIONS = {
  idle: '주인이 지금 아무 작업도 안 하고 있어. 심심하니까 한마디 해줘.',
  working: '주인이 지금 코딩 작업 중이야. 응원하거나 관련된 한마디 해줘.',
  error: '주인한테 에러가 발생했어. 위로하거나 힘내라고 한마디 해줘.',
  morning: '아침이야. 출근 인사를 해줘.',
  lunch: '점심시간이야. 밥 먹으라고 한마디 해줘.',
  evening: '저녁시간이야. 퇴근하라고 한마디 해줘.',
  night: '밤 늦게까지 일하고 있어. 걱정하면서 한마디 해줘.',
  greeting: '주인이 오늘 처음 대시보드를 열었어. 반갑게 인사해줘.',
};

module.exports = { GRADES, PETS, PERSONALITIES, SITUATIONS };
