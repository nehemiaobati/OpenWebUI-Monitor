"""title: Usage Monitor
author: VariantConst, OVINC CN & nehemiaobati
git_url: https://github.com/VariantConst/OpenWebUI-Monitor.git
version: 0.3.9
required_open_webui_version: 0.12.5
requirements: httpx
license: MIT
"""

import json
import logging
import time
from typing import Any, Callable, Dict, List, Optional

from httpx import AsyncClient, Timeout
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

TRANSLATIONS: Dict[str, Dict[str, str]] = {
    "en": {
        "request_failed": "Request failed: {error_msg}",
        "insufficient_balance": "Insufficient balance: Current balance `{balance:.4f}`. Top up at: {topup_url}",
        "insufficient_balance_simple": "Insufficient balance: Current balance `{balance:.4f}`. Please recharge your account.",
        "cost": "Cost: ${cost:.4f}",
        "balance": "Balance: ${balance:.4f}",
        "tokens": "Tokens: {input}+{output}",
        "time_spent": "Time: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
    },
    "zh": {
        "request_failed": "请求失败: {error_msg}",
        "insufficient_balance": "余额不足: 当前余额 `{balance:.4f}`. 充值地址: {topup_url}",
        "insufficient_balance_simple": "余额不足: 当前余额 `{balance:.4f}`. 请联系管理员充值。",
        "cost": "费用: ¥{cost:.4f}",
        "balance": "余额: ¥{balance:.4f}",
        "tokens": "Token: {input}+{output}",
        "time_spent": "耗时: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
    },
    "es": {
        "request_failed": "Solicitud fallida: {error_msg}",
        "insufficient_balance": "Saldo insuficiente: Saldo actual `{balance:.4f}`. Recarga en: {topup_url}",
        "insufficient_balance_simple": "Saldo insuficiente: Saldo actual `{balance:.4f}`. Por favor recarga tu cuenta.",
        "cost": "Costo: ${cost:.4f}",
        "balance": "Saldo: ${balance:.4f}",
        "tokens": "Tokens: {input}+{output}",
        "time_spent": "Tiempo: {time:.2f}s",
        "tokens_per_sec": "{tokens_per_sec:.2f} T/s",
    },
}


class CustomException(Exception):
    pass


def _to_serializable(obj: Any) -> Any:
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    return str(obj)


def serialize_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    return json.loads(json.dumps(payload, default=_to_serializable))


def extract_dict(obj: Any) -> Dict[str, Any]:
    if not obj:
        return {}
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    try:
        return dict(obj)
    except Exception:
        return {}


class Filter:
    class Valves(BaseModel):
        api_endpoint: str = Field(
            default="",
            description="OpenWebUI Monitor base URL (e.g. http://monitor.example.com:7878)",
        )
        api_key: str = Field(
            default="",
            description="OpenWebUI Monitor API key for authentication",
        )
        topup_amount: float = Field(
            default=10.0,
            description="Default recharge amount to initialize on Paystack",
        )
        priority: int = Field(
            default=5,
            description="Filter priority order",
        )
        language: str = Field(
            default="en",
            description="Message language (en/zh/es)",
        )
        show_time_spent: bool = Field(
            default=True,
            description="Show request duration",
        )
        show_tokens_per_sec: bool = Field(
            default=True,
            description="Show token generation speed (tokens/sec)",
        )
        show_cost: bool = Field(
            default=True,
            description="Show message cost",
        )
        show_balance: bool = Field(
            default=True,
            description="Show remaining balance",
        )
        show_tokens: bool = Field(
            default=True,
            description="Show prompt and completion token counts",
        )

    def __init__(self):
        self.type = "filter"
        self.name = "OpenWebUI Monitor"
        self.valves = self.Valves()

    def get_text(self, key: str, **kwargs: Any) -> str:
        lang = self.valves.language if self.valves.language in TRANSLATIONS else "en"
        text = TRANSLATIONS[lang].get(key, TRANSLATIONS["en"].get(key, key))
        return text.format(**kwargs) if kwargs else text

    @property
    def base_url(self) -> str:
        return self.valves.api_endpoint.strip().rstrip("/")

    async def _initialize_paystack_url(
        self, client: AsyncClient, user_dict: Dict[str, Any]
    ) -> Optional[str]:
        user_id = user_dict.get("id")
        if not user_id:
            return None

        email = user_dict.get("email") or f"{user_id}@openwebui.local"
        payload = {
            "email": email,
            "amount": self.valves.topup_amount,
            "userId": str(user_id),
            "callback_url": f"{self.base_url}/api/v1/billing/webhook",
        }

        try:
            response = await client.post(
                url=f"{self.base_url}/api/v1/billing/paystack",
                headers={
                    "Authorization": f"Bearer {self.valves.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            data = response.json()
            if response.is_success and data.get("success"):
                return data.get("data", {}).get("authorization_url")
        except Exception as exc:
            logger.warning("Could not initialize Paystack authorization link: %s", exc)

        return None

    def _build_stats_string(
        self,
        response_data: Dict[str, Any],
        elapsed_time: Optional[float],
    ) -> str:
        stats_list: List[str] = []

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

        if elapsed_time is not None and self.valves.show_time_spent:
            stats_list.append(self.get_text("time_spent", time=elapsed_time))
            if self.valves.show_tokens_per_sec and elapsed_time > 0:
                output_tokens = response_data.get("outputTokens", 0)
                speed = output_tokens / elapsed_time
                stats_list.append(self.get_text("tokens_per_sec", tokens_per_sec=speed))

        return " | ".join(stats_list)

    async def inlet(
        self,
        body: dict,
        __metadata__: Optional[dict] = None,
        __user__: Optional[dict] = None,
    ) -> dict:
        user_dict = extract_dict(__user__)
        start_time = time.monotonic()

        if __metadata__ is not None:
            __metadata__["_usage_monitor_start_time"] = start_time

        if not self.base_url:
            raise CustomException("OpenWebUI Monitor api_endpoint is not configured in Valves.")

        payload = serialize_payload({"user": user_dict, "body": body})

        async with AsyncClient(timeout=Timeout(30.0)) as client:
            try:
                response = await client.post(
                    url=f"{self.base_url}/api/v1/inlet",
                    headers={"Authorization": f"Bearer {self.valves.api_key}"},
                    json=payload,
                )

                try:
                    data = response.json()
                except Exception as exc:
                    raise CustomException(
                        f"Inlet verification failed: Invalid response (HTTP {response.status_code})"
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
                    auth_url = await self._initialize_paystack_url(client, user_dict)
                    if auth_url:
                        message = self.get_text(
                            "insufficient_balance",
                            balance=current_balance,
                            topup_url=auth_url,
                        )
                    else:
                        message = self.get_text(
                            "insufficient_balance_simple",
                            balance=current_balance,
                        )
                    logger.info(message)
                    raise CustomException(message)

                response.raise_for_status()
                return body

            except Exception as err:
                if isinstance(err, CustomException):
                    raise err
                logger.exception(self.get_text("request_failed", error_msg=str(err)))
                raise Exception(f"Error checking balance: {err}") from err

    async def outlet(
        self,
        body: dict,
        __metadata__: Optional[dict] = None,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable] = None,
    ) -> dict:
        user_dict = extract_dict(__user__)
        user_id = user_dict.get("id", "default")

        is_outage = (
            bool(__metadata__.get("_usage_monitor_outage", False))
            if __metadata__ is not None
            else False
        )
        if is_outage or not self.base_url:
            return body

        payload = serialize_payload({"user": user_dict, "body": body})

        async with AsyncClient(timeout=Timeout(30.0)) as client:
            try:
                response = await client.post(
                    url=f"{self.base_url}/api/v1/outlet",
                    headers={"Authorization": f"Bearer {self.valves.api_key}"},
                    json=payload,
                )

                try:
                    response_data = response.json()
                except Exception as exc:
                    raise CustomException(
                        f"Outlet processing failed: Invalid response (HTTP {response.status_code})"
                    ) from exc

                response.raise_for_status()

                start_time = (
                    __metadata__.get("_usage_monitor_start_time")
                    if __metadata__ is not None
                    else None
                )
                elapsed_time = (
                    time.monotonic() - start_time
                    if start_time is not None
                    else None
                )

                stats_display = self._build_stats_string(response_data, elapsed_time)

                if __event_emitter__ and stats_display:
                    await __event_emitter__(
                        {
                            "type": "status",
                            "data": {"description": stats_display, "done": True},
                        }
                    )

                logger.info("usage_monitor: %s %s", user_id, stats_display)
                return body

            except Exception as err:
                logger.exception(self.get_text("request_failed", error_msg=str(err)))
                raise Exception(self.get_text("request_failed", error_msg=str(err))) from err
