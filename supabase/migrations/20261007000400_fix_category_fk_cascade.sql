-- TICKETO — correctif : suppression d'un événement ayant des commandes non payées.
-- Les clés étrangères order_items/tickets -> ticket_categories (NO ACTION) bloquaient la suppression
-- en cascade d'un événement. Passage en ON DELETE CASCADE : sans risque, car la suppression d'une
-- catégorie ayant des commandes est déjà interdite par update_event et par l'API (EVENT_HAS_SALES).

alter table public.order_items
  drop constraint order_items_category_id_fkey,
  add constraint order_items_category_id_fkey
    foreign key (category_id) references public.ticket_categories (id) on delete cascade;

alter table public.tickets
  drop constraint tickets_category_id_fkey,
  add constraint tickets_category_id_fkey
    foreign key (category_id) references public.ticket_categories (id) on delete cascade;
