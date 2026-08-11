import type { PlanResult } from './provider.js';

export interface ProjectExtensionProposalPromptInput {
  projectName: string;
  completedObjective: string;
  contractVersion?: number;
  contractSummary?: string;
  completedCapabilities?: string[];
  projectBrief?: string;
  continuation: boolean;
}

export function buildProjectExtensionProposalPrompt(input: ProjectExtensionProposalPromptInput): string {
  return [
    'Navrhni jedno další ucelené a hodnotné produktové rozšíření projektu.',
    'Rozšíření musí být dostatečně komplexní pro samostatný roadmap cyklus složený z několika navazujících implementačních tasků. Nenavrhuj izolovanou drobnou funkci, kosmetickou úpravu ani technický refaktor bez zřetelné hodnoty pro uživatele.',
    '',
    `Projekt: ${input.projectName}`,
    `Dokončený cíl aktuálního cyklu: ${input.completedObjective}`,
    input.contractVersion ? `Aktuální verze projektového kontraktu: ${input.contractVersion}` : undefined,
    input.contractSummary?.trim() ? `Shrnutí aktuálního kontraktu: ${input.contractSummary.trim()}` : undefined,
    input.completedCapabilities?.length
      ? `Již dodané schopnosti, které se nesmí znovu navrhovat:\n${input.completedCapabilities.map((capability) => `- ${capability}`).join('\n')}`
      : undefined,
    !input.continuation && input.projectBrief?.trim()
      ? `Původní projektové zadání:\n${input.projectBrief.trim()}`
      : undefined,
    input.continuation
      ? 'Navaž na existující projektovou plánovací session. Aktuální repozitář, projektový kontrakt a uložená roadmapa jsou autoritativní.'
      : 'Drž se původního zadání, aktuálního kontraktu a skutečného stavu projektu.',
    '',
    'Celý výstup napiš česky.',
    'Do pole summary napiš přibližně 180 až 350 slov. Uveď výstižný název rozšíření, jeho cíl a přínos, hlavní uživatelský scénář, návaznost na hotový projekt a jasné hranice rozsahu.',
    'Do pole steps vlož 4 až 8 konkrétních funkčních oblastí rozšíření. Jde o produktový rozsah, nikoli o implementační tasky.',
    'Do pole acceptanceCriteria vlož 3 až 6 měřitelných kritérií úspěchu celého rozšíření.',
    '',
    'Popiš konkrétní produktové chování a hodnotu. Neopakuj dokončený rozsah a nic neimplementuj.',
    'Pole validationChecks a implementationSteps nech prázdná; projectContract a architectureUpdate nenavrhuj. Podrobná implementační roadmapa vznikne až po schválení uživatelem.'
  ].filter((line): line is string => Boolean(line)).join('\n');
}

export function formatProjectExtensionProposal(plan: Pick<PlanResult, 'summary' | 'steps' | 'acceptanceCriteria'>): string {
  const summary = plan.summary.trim();
  const functionalScope = normalizeItems(plan.steps);
  const successCriteria = normalizeItems(plan.acceptanceCriteria);

  if (summary.length < 120 || functionalScope.length < 3 || successCriteria.length < 3) {
    throw new Error('AI provider returned an extension proposal that is too brief or incomplete.');
  }

  return [
    summary,
    '',
    '## Funkční rozsah',
    ...functionalScope.map((item) => `- ${item}`),
    '',
    '## Měřitelná kritéria úspěchu',
    ...successCriteria.map((item) => `- ${item}`)
  ].join('\n');
}

function normalizeItems(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
