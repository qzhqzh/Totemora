# Invoice API incident fixture

The `invoice-api` accepts idempotent invoice creation requests and enqueues PDF generation.

- Availability objective: 99.9% monthly.
- A request is accepted only after the invoice row and idempotency key are committed together.
- A network timeout after dispatch has an **unknown outcome**. Operators must inspect the action journal before retrying.
- The notification channel is optional: its failure must not roll back a committed invoice.

This fixture is read-only evidence. It does not prove that recovery commands were executed.
