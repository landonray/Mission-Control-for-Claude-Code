const MODEL_ROLES = {
  default: process.env.MODEL_DEFAULT || 'claude-opus-4-7',
  fast:    process.env.MODEL_FAST    || 'claude-haiku-4-5',
  strong:  process.env.MODEL_STRONG  || 'claude-opus-4-7',
  quality: process.env.MODEL_QUALITY || 'claude-sonnet-4-6',
};

const DEFAULT_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'Opus' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet' },
];

function parseModelOptions() {
  const env = process.env.MODEL_OPTIONS;
  if (!env) return DEFAULT_OPTIONS;
  return env.split(',').map(entry => {
    const [value, label] = entry.split(':');
    return { value: value.trim(), label: label?.trim() || value.trim() };
  });
}

const MODEL_OPTIONS = parseModelOptions();
const VALID_MODELS = MODEL_OPTIONS.map(o => o.value);
const DEFAULT_MODEL = MODEL_ROLES.default;

function isValidModel(model) {
  return VALID_MODELS.includes(model);
}

module.exports = { MODEL_ROLES, MODEL_OPTIONS, VALID_MODELS, DEFAULT_MODEL, isValidModel };
