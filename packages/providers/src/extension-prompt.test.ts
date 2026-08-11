import { describe, expect, it } from 'vitest';
import { buildProjectExtensionProposalPrompt, formatProjectExtensionProposal } from './extension-prompt.js';

describe('project extension proposal prompt', () => {
  it('requests a detailed Czech product extension instead of implementation steps', () => {
    const prompt = buildProjectExtensionProposalPrompt({
      projectName: 'Focus Ledger',
      completedObjective: 'Dokoncit zakladni evidenci soustredeni.',
      contractVersion: 2,
      contractSummary: 'Uzivatel eviduje a vyhodnocuje bloky soustredeni.',
      completedCapabilities: ['Evidence bloku', 'Tydenni prehled'],
      continuation: true
    });

    expect(prompt).toContain('dostatečně komplexní pro samostatný roadmap cyklus');
    expect(prompt).toContain('Celý výstup napiš česky');
    expect(prompt).toContain('4 až 8 konkrétních funkčních oblastí');
    expect(prompt).toContain('3 až 6 měřitelných kritérií');
    expect(prompt).toContain('- Evidence bloku');
    expect(prompt).toContain('implementationSteps nech prázdná');
  });

  it('includes the brief only when no compatible planning session can be resumed', () => {
    const initialPrompt = buildProjectExtensionProposalPrompt({
      projectName: 'Demo',
      completedObjective: 'Zaklad je hotovy.',
      projectBrief: 'Dlouhodobe autoritativni zadani projektu.',
      continuation: false
    });
    const continuationPrompt = buildProjectExtensionProposalPrompt({
      projectName: 'Demo',
      completedObjective: 'Zaklad je hotovy.',
      projectBrief: 'Dlouhodobe autoritativni zadani projektu.',
      continuation: true
    });

    expect(initialPrompt).toContain('Dlouhodobe autoritativni zadani projektu.');
    expect(continuationPrompt).not.toContain('Dlouhodobe autoritativni zadani projektu.');
  });

  it('formats and validates a sufficiently detailed proposal', () => {
    const proposal = formatProjectExtensionProposal({
      summary: 'Rozšíření přidá týmové cíle a společné vyhodnocování soustředění. Uživatelé budou moci založit tým, sdílet vybrané výsledky a sledovat společný pokrok bez zveřejnění citlivých poznámek. Funkce naváže na existující evidenci a zachová individuální používání aplikace.',
      steps: ['Správa týmů', 'Sdílené cíle', 'Přehled pokroku'],
      acceptanceCriteria: ['Uživatel vytvoří tým.', 'Členové vidí společný cíl.', 'Soukromé poznámky se nesdílejí.']
    });

    expect(proposal).toContain('## Funkční rozsah\n- Správa týmů');
    expect(proposal).toContain('## Měřitelná kritéria úspěchu');
  });

  it('rejects a one-line idea without a complete product scope', () => {
    expect(() => formatProjectExtensionProposal({
      summary: 'Přidat export.',
      steps: ['Export'],
      acceptanceCriteria: ['Export funguje.']
    })).toThrow('too brief or incomplete');
  });
});
