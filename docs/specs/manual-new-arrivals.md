# Manual Hàng mới về

Owner decision (2026-10-12): `/new-arrivals` is curated by an administrator, not by
`ProductMirror.createdAt`. The visible list is ordered according to `NewArrivalProduct.position`.

- Admin UI: `/admin/new-arrivals`, sign-in and `ADMIN` role required.
- Search by name, product code or slug; add, remove and move an entry up/down.
- Membership does not expire and is not inferred from Pancake synchronization.
- An empty list remains empty; invisible products are skipped without backfill.
- Public listing uses 24 items per page and the existing promotion pricing rules.
- Writes are atomic and serializable. No storefront writer may mutate selection.
- The new table starts empty. Operators must curate their first selection after migration.

This is separate from homepage `HomepageFeaturedProduct`, used by SPECIAL DEALS.
The homepage refresh removed its previous Hàng mới về section; this feature changes the
public `/new-arrivals` listing, not homepage section order.
