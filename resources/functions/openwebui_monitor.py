"""
title: Usage Monitor
author: VariantConst & OVINC CN
git_url: https://github.com/VariantConst/OpenWebUI-Monitor.git
version: 0.3.9
required_open_webui_version: 0.4.0
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

TRANSLATIONS: Dict[str, Dict[str, str]] = {
    "en": {
        "request_failed": "Request failed: {error_msg}",
        "insufficient_balance": "Insufficient balance: Current balance `{balance:.4f}`. Top up at: {topup_url}",
        "cost": "Cost: ${cost:.4f}",
        "balance": "Balance: ${balance:.4f}",
        "tokens": "Tokens: {input}+{output}",
        "time_spent": "Time: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
        "endpoint_not_configured": "OpenWebUI Monitor API endpoint is not configured in Valves.",
    },
    "zh": {
        "request_failed": "请求失败: {error_msg}",
        "insufficient_balance": "余额不足: 当前余额 `{balance:.4f}`. 充值地址: {topup_url}",
        "cost": "费用: ¥{cost:.4f}",
        "balance": "余额: ¥{balance:.4f}",
        "tokens": "Token: {input}+{output}",
        "time_spent": "耗时: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
        "endpoint_not_configured": "OpenWebUI Monitor 插件未配置 API Endpoint。",
    },
    "es": {
        "request_failed": "Solicitud fallida: {error_msg}",
        "insufficient_balance": "Saldo insuficiente: Saldo actual `{balance:.4f}`. Recarga en: {topup_url}",
        "cost": "Costo: ${cost:.4f}",
        "balance": "Saldo: ${balance:.4f}",
        "tokens": "Tokens: {input}+{output}",
        "time_spent": "Tiempo: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
        "endpoint_not_configured": "El endpoint de OpenWebUI Monitor no está configurado en Valves.",
    },
}


class CustomException(Exception):
    pass


def _serialize_for_json(obj: Any) -> Any:
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    return str(obj)


class Filter:
    class Valves(BaseModel):
        api_endpoint: str = Field(
            default="",
            description="OpenWebUI Monitor base URL (e.g. http://127.0.0.1:3000)",
        )
        api_key: str = Field(
            default="",
            description="OpenWebUI Monitor API Key",
        )
        topup_url: str = Field(
            default="",
            description="Custom top-up URL. If left empty, a Paystack checkout session is dynamically generated.",
        )
        topup_amount: float = Field(
            default=10.0,
            description="Default recharge amount to initialize on Paystack",
        )
        priority: int = Field(
            default=5,
            description="Filter priority",
        )
        language: str = Field(
            default="en",
            description="Language code (en/zh/es)",
        )
        show_time_spent: bool = Field(
            default=True,
            description="Show request duration",
        )
        show_tokens_per_sec: bool = Field(
            default=True,
            description="Show generation speed (tokens per second)",
        )
        show_cost: bool = Field(
            default=True,
            description="Show request cost",
        )
        show_balance: bool = Field(
            default=True,
            description="Show remaining account balance",
        )
        show_tokens: bool = Field(
            default=True,
            description="Show token breakdown (input + output)",
        )

    def __init__(self):
        self.type = "filter"
        self.name = "OpenWebUI Monitor"
        self.valves = self.Valves()

    def get_text(self, key: str, **kwargs) -> str:
        lang = self.valves.language if self.valves.language in TRANSLATIONS else "en"
        text = TRANSLATIONS[lang].get(key, TRANSLATIONS["en"].get(key, key))
        return text.format(**kwargs) if kwargs else text

    async def _resolve_topup_url(
        self, client: AsyncClient, user_dict: dict
    ) -> str:
        if self.valves.topup_url:
            return self.valves.topup_url.strip()

        base_url = self.valves.api_endpoint.rstrip("/")
        user_id = user_dict.get("id")
        if not user_id:
            return f"{base_url}/panel"

        email = user_dict.get("email") or f"{user_id}@openwebui.local"
        payload = {
            "email": email,
            "amount": self.valves.topup_amount,
            "userId": user_id,
            "callback_url": f"{base_url}/api/v1/billing/webhook",
        }

        try:
            response = await client.post(
                url=f"{base_url}/api/v1/billing/paystack",
                headers={
                    "Authorization": f"Bearer {self.valves.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            data = response.json()
            if response.is_success and data.get("success"):
                auth_url = data.get("data", {}).get("authorization_url")
                if auth_url:
                    return auth_url
        except Exception as exc:
            logger.warning("Dynamic payment session generation failed: %s", exc)

        return f"{base_url}/panel"

    async def inlet(
        self,
        body: dict,
        __metadata__: Optional[dict] = None,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable] = None,
    ) -> dict:
        if not self.valves.api_endpoint:
            raise CustomException(self.get_text("endpoint_not_configured"))

        user_dict = __user__ or {}
        start_time = time.monotonic()
        if __metadata__ is not None:
            __metadata__["_usage_monitor_start_time"] = start_time

        base_url = self.valves.api_endpoint.rstrip("/")
        serialized_payload = json.loads(
            json.dumps({"user": user_dict, "body": body}, default=_serialize_for_json)
        )

        async with AsyncClient(timeout=Timeout(30.0)) as client:
            try:
                response = await client.post(
                    url=f"{base_url}/api/v1/inlet",
                    headers={"Authorization": f"Bearer {self.valves.api_key}"},
                    json=serialized_payload,
                )
                try:
                    data = response.json()
                except Exception as exc:
                    raise CustomException(
                        f"Inlet check failed: Invalid response (HTTP {response.status_code})"
                    ) from exc

                current_balance = float(data.get("balance", 0.0))
                is_outage = (
                    response.status_code == 402
                    or not data.get("success", False)
                    or current_balance <= 0.0
                )

                if __metadata__ is not None:
                    __metadata__["_usage_monitor_outage"] = is_outage

                if is_outage:
                    topup_link = await self._resolve_topup_url(client, user_dict)
                    msg = self.get_text(
                        "insufficient_balance",
                        balance=current_balance,
                        topup_url=topup_link,
                    )
                    logger.info(msg)
                    raise CustomException(msg)

                response.raise_for_status()
                return body
            except Exception as err:
                if isinstance(err, CustomException):
                    raise err
                logger.exception(self.get_text("request_failed", error_msg=str(err)))
                raise Exception(f"error calculating usage, {err}") from err

    async def outlet(
        self,
        body: dict,
        __metadata__: Optional[dict] = None,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable] = None,
    ) -> dict:
        if not self.valves.api_endpoint:
            return body

        user_dict = __user__ or {}
        user_id = user_dict.get("id", "default")

        is_outage = (
            bool(__metadata__.get("_usage_monitor_outage", False))
            if __metadata__ is not None
            else False
        )
        if is_outage:
            return body

        base_url = self.valves.api_endpoint.rstrip("/")
        serialized_payload = json.loads(
            json.dumps({"user": user_dict, "body": body}, default=_serialize_for_json)
        )

        async with AsyncClient(timeout=Timeout(30.0)) as client:
            try:
                response = await client.post(
                    url=f"{base_url}/api/v1/outlet",
                    headers={"Authorization": f"Bearer {self.valves.api_key}"},
                    json=serialized_payload,
                )
                try:
                    response_data = response.json()
                except Exception as exc:
                    raise CustomException(
                        f"Outlet processing failed: Invalid response (HTTP {response.status_code})"
                    ) from exc

                response.raise_for_status()

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
                        self.get_text(
                            "balance", balance=response_data.get("newBalance", 0)
                        )
                    )

                start_time = None
                if __metadata__ is not None:
                    start_time = __metadata__.get("_usage_monitor_start_time")

                if start_time is not None and self.valves.show_time_spent:
                    elapsed = time.monotonic() - start_time
                    stats_list.append(self.get_text("time_spent", time=elapsed))
                    if self.valves.show_tokens_per_sec:
                        output_tokens = response_data.get("outputTokens", 0)
                        tokens_per_sec = (
                            output_tokens / elapsed if elapsed > 0 else 0
                        )
                        stats_list.append(
                            self.get_text(
                                "tokens_per_sec", tokens_per_sec=tokens_per_sec
                            )
                        )

                stats = " | ".join(stats_list)

                if __event_emitter__:
                    await __event_emitter__(
                        {
                            "type": "status",
                            "data": {"description": stats, "done": True},
                        }
                    )

                logger.info("usage_monitor: %s %s", user_id, stats)
                return body
            except Exception as err:
                logger.exception(self.get_text("request_failed", error_msg=str(err)))
                raise Exception(
                    self.get_text("request_failed", error_msg=str(err))
                ) from err
