import type { ProjectAuditJobApi } from './types.js';

export function AuditGapProposalPanel(props: {
  job: ProjectAuditJobApi;
  deciding?: boolean;
  error?: string;
  onDecide?: (accepted: boolean) => void;
}) {
  const { job } = props;
  const proposal = job.gapProposal;
  if (!proposal) return null;
  const pending = job.gapProposalStatus === 'proposed';
  const canDecide = pending && job.status === 'succeeded';
  const busy = (props.deciding && canDecide) || job.gapProposalStatus === 'activating';
  const needsRepair = job.gapProposalReview?.verdict === 'not_satisfied';
  const title = job.gapProposalStatus === 'activated'
    ? 'Návrh z auditu byl aktivován'
    : job.gapProposalStatus === 'dismissed' ? 'Návrh z auditu byl zamítnut' : 'Audit navrhuje opravu';

  return (
    <section className="prompt-response-panel audit-gap-proposal" aria-label="Návrh opravy z auditu">
      <h3>{title}</h3>
      <p>{proposal.summary}</p>
      {pending || busy ? <p>Task zatím nevznikl. Nejdřív zkontrolujte a aktivujte návrh. Po úspěšné AI kontrole vzniknou kroky roadmapy; práci pak spustíte tlačítkem „Spustit další krok“.</p> : null}
      {job.gapProposalStatus === 'activated' ? <p>{proposal.steps.length
        ? 'Kroky jsou v roadmapě. Aktivace sama task nespouští; použijte „Spustit další krok“.'
        : 'AI kontrola potvrdila, že z návrhu nezbývá žádná potřebná oprava. Nové kroky nevznikly.'}</p> : null}
      {pending && needsRepair ? <p>AI zapracuje připomínky do návrhu a provede novou nezávislou kontrolu. Předchozí verze zůstanou v historii.</p> : null}
      <ol className="audit-gap-steps">
        {proposal.steps.map((step, index) => (
          <li key={`${index}-${step.title}`}>
            <strong>{step.title}</strong>
            <p className="audit-gap-description">{step.description}</p>
            <strong>Akceptační kritéria</strong>
            <ul>{step.acceptanceCriteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>
          </li>
        ))}
      </ol>
      <small>Commit původního auditu: {proposal.commitSha}. Aktivace ověřuje návrh nad aktuálním repozitářem.</small>
      {job.gapProposalReview ? <div>
        <p>Výsledek AI kontroly: {job.gapProposalReview.summary}</p>
        {job.gapProposalReview.blockers.length > 0 ? <ul>{job.gapProposalReview.blockers.map((blocker, i) => <li key={i}>{blocker}</li>)}</ul> : null}
      </div> : null}
      {props.error ? <div className="error-banner" role="alert">{props.error}</div> : null}
      {canDecide || busy ? <div className="actions">
        <button className="primary-action" type="button" disabled={busy || !canDecide || !props.onDecide} onClick={() => props.onDecide?.(true)}>
          {busy ? 'Probíhá kontrola návrhu a případná AI oprava…' : needsRepair ? 'Opravit a znovu zkontrolovat návrh' : 'Zkontrolovat a aktivovat návrh'}
        </button>
        <button className="secondary-action" type="button" disabled={busy || !canDecide || !props.onDecide} onClick={() => props.onDecide?.(false)}>Zamítnout návrh</button>
      </div> : null}
    </section>
  );
}
