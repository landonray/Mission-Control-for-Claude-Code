const COLOR_BY_TYPE = {
  manual: 'manual',
  planning: 'blue',
  spec_refinement: 'blue',
  implementation_planning: 'blue',
  qa_design: 'purple',
  implementation: 'green',
  qa_execution: 'orange',
  code_review: 'yellow',
  extraction: 'gray',
  eval_gatherer: 'gray',
};

const BADGE_BY_TYPE = {
  manual: 'M',
  planning: 'P',
  spec_refinement: 'P',
  implementation_planning: 'P',
  qa_design: 'Q',
  qa_execution: 'Q',
  implementation: 'I',
  code_review: 'R',
  extraction: 'E',
  eval_gatherer: 'E',
};

const LABEL_BY_TYPE = {
  manual: 'Manual',
  planning: 'Planning',
  spec_refinement: 'Spec Refinement',
  qa_design: 'QA Design',
  implementation_planning: 'Implementation Planning',
  implementation: 'Implementation',
  qa_execution: 'QA Execution',
  code_review: 'Code Review',
  extraction: 'Extraction',
  eval_gatherer: 'Eval Gatherer',
};

export function colorForSessionType(type) {
  if (!type) return 'manual';
  return COLOR_BY_TYPE[type] || 'manual';
}

export function badgeForSessionType(type) {
  if (!type) return 'M';
  return BADGE_BY_TYPE[type] || 'M';
}

export function labelForSessionType(type) {
  if (!type) return 'Manual';
  return LABEL_BY_TYPE[type] || type;
}
