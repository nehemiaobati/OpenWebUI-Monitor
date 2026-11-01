"""
title: Usage Monitor
author: VariantConst & OVINC CN
git_url: https://github.com/VariantConst/OpenWebUI-Monitor.git
version: 0.3.7
required_open_webui_version: 0.12.5
requirements: httpx
license: MIT
"""

import json
import logging
import time
from typing import Any, Callable, Dict, Optional
from httpx import AsyncClient, Timeout
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

TRANSLATIONS = {
    "en": {
        "request_failed": "Request failed: {error_msg}",
        "insufficient_balance": "Insufficient balance: Current balance `{balance:.4f}`. Top up at: {topup_url}",
        "cost": "Cost: ${cost:.4f}",
        "balance": "Balance: ${balance:.4f}",
        "tokens": "Tokens: {input}+{output}",
        "time_spent": "Time: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
    },
    "zh": {
        "request_failed": "请求失败: {error_msg}",
        "insufficient_balance": "余额不足: 当前余额 `{balance:.4f}`. 充值地址: {topup_url}",
        "cost": "费用: ¥{cost:.4f}",
        "balance": "余额: ¥{balance:.4f}",
        "tokens": "Token: {input}+{output}",
        "time_spent": "耗时: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
    },
    "es": {
        "request_failed": "Solicitud fallida: {error_msg}",
        "insufficient_balance": "Saldo insuficiente: Saldo actual `{balance:.4f}`. Recarga en: {topup_url}",
        "cost": "Costo: ${cost:.4f}",
        "balance": "Saldo: ${balance:.4f}",
        "tokens": "Tokens: {input}+{output}",
        "time_spent": "Tiempo: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
    },
}


class CustomException(Exception):
    pass


def _serialize_for_json(obj: Any) -> Any:
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    return str(obj)


class Filter:
    class Valves(BaseModel):
        api_endpoint: str = Field(
            default="", description="openwebui-monitor's base url"
        )
        api_key: str = Field(default="", description="openwebui-monitor's api key")
        topup_url: str = Field(
            default="", description="top-up URL (e.g. https://monitor.domain/topup)"
        )
        priority: int = Field(default=5, description="filter priority")
        language: str = Field(default="zh", description="language (en/zh/es)")
        show_time_spent: bool = Field(default=True, description="show time spent")
        show_tokens_per_sec: bool = Field(
            default=True, description="show tokens per second"
        )
        show_cost: bool = Field(default=True, description="show cost")
        show_balance: bool = Field(default=True, description="show balance")
        show_tokens: bool = Field(default=True, description="show tokens")

    def __init__(self):
        self.type = "filter"
        self.name = "OpenWebUI Monitor"
        self.valves = self.Valves()

    def get_text(self, key: str, **kwargs) -> str:
        lang = self.valves.language if self.valves.language in TRANSLATIONS else "en"
        text = TRANSLATIONS[lang].get(key, TRANSLATIONS["en"][key])
        return text.format(**kwargs) if kwargs else text

    async def _post_monitor(self, endpoint: str, payload: dict) -> dict:
        serialized_payload = json.loads(
            json.dumps(payload, default=_serialize_for_json)
        )
        async with AsyncClient(timeout=Timeout(30.0)) as client:
            response = await client.post(
                url=f"{self.valves.api_endpoint}{endpoint}",
                headers={"Authorization": f"Bearer {self.valves.api_key}"},
                json=serialized_payload,
            )
            response.raise_for_status()
            data = response.json()
            if not data.get("success"):
                error_desc = data.get("error", data)
                raise CustomException(
                    self.get_text("request_failed", error_msg=error_desc)
                )
            return data

    async def inlet(
        self,
        body: dict,
        __metadata__: Optional[dict] = None,
        __user__: Optional[dict] = None,
    ) -> dict:
        user_dict = __user__ or {}
        user_id = user_dict.get("id", "default")
        start_time = time.monotonic()

        if __metadata__ is not None:
            __metadata__["_usage_monitor_start_time"] = start_time

        try:
            response_data = await self._post_monitor(
                endpoint="/api/v1/inlet",
                payload={"user": user_dict, "body": body},
            )

            is_outage = response_data.get("balance", 0) <= 0
            if __metadata__ is not None:
                __metadata__["_usage_monitor_outage"] = is_outage

            if is_outage:
                current_balance = response_data.get("balance", 0)
                topup_url = self.valves.topup_url or f"{self.valves.api_endpoint.rstrip('/')}/topup"
                msg = self.get_text("insufficient_balance", balance=current_balance, topup_url=topup_url)
                logger.info(msg)
                raise CustomException(msg)

            return body

        except Exception as err:
            logger.exception(self.get_text("request_failed", error_msg=err))
            if isinstance(err, CustomException):
                raise err
            raise Exception(f"error calculating usage, {err}") from err

    async def outlet(
        self,
        body: dict,
        __metadata__: Optional[dict] = None,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable] = None,
    ) -> dict:
        user_dict = __user__ or {}
        user_id = user_dict.get("id", "default")

        is_outage = bool(__metadata__.get("_usage_monitor_outage", False)) if __metadata__ is not None else False
        if is_outage:
            return body

        try:
            response_data = await self._post_monitor(
                endpoint="/api/v1/outlet",
                payload={"user": user_dict, "body": body},
            )

            stats_list = []
            if self.valves.show_tokens:
                stats_list.append(
                    self.get_text(
                        "tokens",
                        input=response_data.get("inputTokens", 0),
                        output=response_data.get("outputTokens", 0),
                    )
                )
            if self.valves.show_cost:
                stats_list.append(
                    self.get_text("cost", cost=response_data.get("totalCost", 0))
                )
            if self.valves.show_balance:
                stats_list.append(
                    self.get_text("balance", balance=response_data.get("newBalance", 0))
                )

            start_time = None
            if __metadata__ is not None:
                start_time = __metadata__.get("_usage_monitor_start_time")

            if start_time is not None and self.valves.show_time_spent:
                elapsed = time.monotonic() - start_time
                stats_list.append(self.get_text("time_spent", time=elapsed))
                if self.valves.show_tokens_per_sec:
                    output_tokens = response_data.get("outputTokens", 0)
                    tokens_per_sec = output_tokens / elapsed if elapsed > 0 else 0
                    stats_list.append(
                        self.get_text("tokens_per_sec", tokens_per_sec=tokens_per_sec)
                    )

            stats = " | ".join(stats_list)
            if __event_emitter__:
                await __event_emitter__(
                    {"type": "status", "data": {"description": stats, "done": True}}
                )

            logger.info("usage_monitor: %s %s", user_id, stats)
            return body

        except Exception as err:
            logger.exception(self.get_text("request_failed", error_msg=err))
            raise Exception(self.get_text("request_failed", error_msg=err)) from err
