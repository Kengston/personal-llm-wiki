"""
telegram.py — тонкий клиент Telegram Bot API.

По рекомендации docs/research/telegram-interface.md мост дёргает Bot API НАПРЯМУЮ
через httpx (без aiogram/python-telegram-bot): мост в основном делает sendMessage +
sendChatAction + getMe, и второй event-loop/dispatcher внутри FastAPI ни к чему.
Если позже понадобятся типизированные модели/FSM/фильтры — заменить реализацию
за тем же интерфейсом `TelegramClient` (шов портируемости).

Исходящий путь проактивных пушей (scheduler) тоже использует этот клиент: движок
остаётся side-effect-free, а Telegram-вызов делает мост/планировщик.

[research]: ../docs/research/telegram-interface.md
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import httpx
import structlog

log = structlog.get_logger(__name__)

# Лимит длины одного сообщения Telegram — 4096 символов. Режем длинные ответы движка.
_TELEGRAM_MAX_MESSAGE_CHARS = 4096


class TelegramClient(ABC):
    """
    Абстрактный исходящий клиент Telegram (шов портируемости/тестируемости).

    Позволяет подменить реальный Bot API на mock в тестах или на aiogram-обёртку,
    не трогая worker. Минимальная поверхность: отправить сообщение, показать
    «печатает…», проверить токен.
    """

    @abstractmethod
    async def send_message(self, chat_id: int, text: str) -> None: ...

    @abstractmethod
    async def send_chat_action(self, chat_id: int, action: str = "typing") -> None: ...

    @abstractmethod
    async def get_me(self) -> dict: ...

    @abstractmethod
    async def aclose(self) -> None: ...


class BotApiTelegramClient(TelegramClient):
    """
    Реальный клиент поверх api.telegram.org через httpx.AsyncClient.

    Один долгоживущий AsyncClient переиспользует TCP-соединения. Все вызовы —
    POST `https://api.telegram.org/bot<token>/<method>` с JSON-телом.
    """

    def __init__(self, bot_token: str, *, api_base: str = "https://api.telegram.org") -> None:
        if not bot_token:
            raise ValueError("TELEGRAM_BOT_TOKEN пуст — клиент Telegram не сконфигурирован.")
        # Базовый URL метода: .../bot<token>. Сам токен в логи не пишем.
        self._method_base = f"{api_base.rstrip('/')}/bot{bot_token}"
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(20.0))

    async def send_message(self, chat_id: int, text: str) -> None:
        """
        Отправить текст в чат. Длинные ответы движка режем на части по 4096 символов
        (Telegram отклонит более длинное сообщение). Без edit-streaming — целиком.
        """
        for chunk in _chunk_text(text, _TELEGRAM_MAX_MESSAGE_CHARS):
            await self._call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": chunk,
                    # Без parse_mode: ответ движка — произвольный текст; включать
                    # Markdown/HTML-парсинг небезопасно (легко словить 400 на разметке).
                    "disable_web_page_preview": True,
                },
            )

    async def send_chat_action(self, chat_id: int, action: str = "typing") -> None:
        """
        Показать индикатор «печатает…». Маскирует латентность движка (секунды-десятки).
        Best-effort: ошибку не пробрасываем (индикатор не критичен).
        """
        try:
            await self._call("sendChatAction", {"chat_id": chat_id, "action": action})
        except httpx.HTTPError as exc:  # pragma: no cover - косметика
            log.debug("telegram.chat_action_failed", error=str(exc))

    async def get_me(self) -> dict:
        """Вызвать getMe — health-проверка токена/связи (используется в /health)."""
        return await self._call("getMe", {})

    async def aclose(self) -> None:
        """Закрыть httpx-клиент на shutdown моста."""
        await self._client.aclose()

    # ----------------------------- internal ------------------------------- #

    async def _call(self, method: str, payload: dict) -> dict:
        """
        Низкоуровневый POST к Bot API. Поднимает на HTTP-ошибке или ok=false.

        Возвращает поле `result` из ответа Telegram.
        """
        resp = await self._client.post(f"{self._method_base}/{method}", json=payload)
        # 4xx/5xx → исключение (worker решит, что делать; чаще просто залогирует).
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok", False):
            # Telegram вернул ok=false с описанием — это логическая ошибка вызова.
            description = data.get("description", "unknown Bot API error")
            log.warning("telegram.api_not_ok", method=method, description=description)
            raise httpx.HTTPError(f"Telegram {method} вернул ok=false: {description}")
        return data.get("result", {})


def _chunk_text(text: str, limit: int) -> list[str]:
    """
    Порезать текст на части не длиннее `limit`, стараясь рвать по границам строк.

    Простая стратегия: режем по \n, накапливая части до лимита; слишком длинную
    строку режем жёстко по символам. Достаточно для ответов ассистента.
    """
    if len(text) <= limit:
        return [text] if text else [""]

    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        # +1 на перевод строки между line'ами.
        if len(current) + len(line) + 1 > limit:
            if current:
                chunks.append(current)
                current = ""
            # Сама строка длиннее лимита — режем жёстко.
            while len(line) > limit:
                chunks.append(line[:limit])
                line = line[limit:]
        current = f"{current}\n{line}" if current else line
    if current:
        chunks.append(current)
    return chunks
