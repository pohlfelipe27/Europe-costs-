-- Atualização 2: gastos em libra (GBP).
-- Rode uma vez no SQL Editor do Supabase. Pode rodar de novo sem problema.

-- Cotação padrão da libra na viagem (1 £ = ? na moeda da viagem).
alter table public.trips
  add column if not exists gbp_rate numeric(12,6);

-- Valor original pago em libra e a cotação usada na conversão.
-- A coluna "amount" continua sendo o valor já convertido para a moeda da viagem.
alter table public.expenses
  add column if not exists original_currency text,
  add column if not exists original_amount numeric(12,2),
  add column if not exists fx_rate numeric(12,6);
