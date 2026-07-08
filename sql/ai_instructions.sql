-- AI Bot: свободное поле «Инструкция для AI» в карточке guest_instructions.
-- Идемпотентно.
ALTER TABLE public.guest_instructions
  ADD COLUMN IF NOT EXISTS ai_instructions text;

COMMENT ON COLUMN public.guest_instructions.ai_instructions IS
  'Свободный текст, который бот использует как ЕДИНСТВЕННЫЙ источник правды для AI-ответов гостю по этой квартире. Если пусто — AI-режим выключен, поведение как раньше (передача менеджеру).';
