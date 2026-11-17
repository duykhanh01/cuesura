# Advisor authority

Use an advisor only for decisions worth the extra context: decomposition, disputed premises or a
root choice behind repeated findings. It is not a mandatory hop for ordinary implementation.
At Intake, inherit an existing choice or ask once for `decide`, `advise`, or none. For decide,
record the delegated subject, constraints, exclusions and conditions requiring the user. Record
changes/revocation immediately, update affected briefs and notify workers. A revoked or out-of-scope
advisor can recommend but cannot issue an effective decision.

Worker question → lead checks existing rules/decisions → advisor when relevant and within scope →
advisor saves its report → lead relays the conclusion. In advise mode, recommendations leave
choices with the lead/user according to the existing grant. In decide mode, authorized decisions
stand without a second full review by the lead. Read deeper for contradictory evidence, objections
or suspected scope violations. Anything outside the grant returns to its actual decision owner.

The advisor writes `reports/<parent>-advisor.md`, current summary first. Each record has stable ID
`T4-D1`, timestamp, question, conclusion, reasoning/evidence, tradeoffs, applicable scope and status
(`recommended`, `active`, `superseded`, `revoked`). Keep a successor link when superseded. Before
reporting, save the record. Reply only with ID, one-sentence conclusion, affected tasks and path.
The lead keeps a reference to active decisions in the ledger, not another copy of their reasoning.
Lead rulings remain lead-written. A decision still affecting another task stays referenced after
archive; retired shared decisions link from `archive/run-decisions.md`, task-local ones from the
parent archive. The helper never infers whether a decision remains active.

Do not assign the advisor as independent reviewer of its own proposal by default. Technical or
business delegation does not grant merge, deployment, credentials or expanded product scope.
