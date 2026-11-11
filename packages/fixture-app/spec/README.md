# Fixture spec docs (T3.3)

The written spec of fixture-app: the ground truth for the accuracy tests of the spec pipeline (the markdown
adapter, T3.2, and Derive, P4). The documents are product data, so they are in Vietnamese like the app.

Format, so a `sourceRef` quote can point at exactly one sentence:

- Front matter gives the operation `id`, `title` and `actor` (a profile of the fixture: `employee`, `manager`).
- The heading path is the `context.headings` of each expected item; the line before a list ("Khi gửi thành
  công:") is its `leadIn`, or there is none.
- Every bullet under "Kết quả mong đợi" (and under "Phân quyền") is **one whole sentence and one expected item**.
  A quoted literal ("Đã gửi đơn") is the item's `value`.

Each seeded bug is contradicted by at least one sentence (`index.json` maps them). A change to the app that
makes a sentence false must change this spec in the same pull request.
