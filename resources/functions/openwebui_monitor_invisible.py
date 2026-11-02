"""
title: Usage Monitor (Invisible)
author: fl0w1nd & VariantConst
git_url: https://github.com/VariantConst/OpenWebUI-Monitor.git
version: 0.3.9
required_open_webui_version: 0.4.0
requirements: httpx
license: MIT
"""

import json
import logging
import os
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
        "api_key_invalid": "API key verification failed",
        "unable_to_get_message_id": "Unable to identify message ID",
        "endpoint_not_configured": "OpenWebUI Monitor API endpoint is not configured in Valves.",
    },
    "zh": {
        "request_failed": "请求失败: {error_msg}",
        "insufficient_balance": "余额不足: 当前余额 `{balance:.4f}`. 充值地址: {topup_url}",
        "api_key_invalid": "API密钥验证失败",
        "unable_to_get_message_id": "无法获取消息ID",
        "endpoint_not_configured": "OpenWebUI Monitor 插件未配置 API Endpoint。",
    },
    "es": {
        "request_failed": "Solicitud fallida: {error_msg}",
        "insufficient_balance": "Saldo insuficiente: Saldo actual `{balance:.4f}`. Recarga en: {topup_url}",
        "api_key_invalid": "Error de autenticación de clave API",
        "unable_to_get_message_id": "No se puede obtener el ID del mensaje",
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
            default="", description="The base URL for the API endpoint (e.g. http://127.0.0.1:3000)."
        )
        api_key: str = Field(
            default="", description="API key for authentication."
        )
        topup_url: str = Field(
            default="",
            description="Custom top-up URL. If left empty, a Paystack checkout session is generated.",
        )
        topup_amount: float = Field(
            default=10.0,
            description="Default recharge amount to initialize on Paystack",
        )
        priority: int = Field(
            default=5, description="Priority level for filter execution."
        )
        language: str = Field(
            default="en", description="Language code for user messages (en/zh/es)."
        )

    def __init__(self):
        self.type = "filter"
        self.name = "OpenWebUI Monitor"
        self.valves = self.Valves()

    def get_text(self, key: str, **kwargs) -> str:
        lang = self.valves.language if self.valves.language in TRANSLATIONS else "en"
        text = TRANSLATIONS[lang].get(key, TRANSLATIONS["en"].get(key, key))
        return text.format(**kwargs) if kwargs else text

    def _resolve_message_id(
        self, body: dict, metadata: Optional[dict] = None
    ) -> Optional[str]:
        if body.get("id"):
            return str(body["id"])

        messages = body.get("messages", [])
        for msg in reversed(messages):
            if msg.get("role") == "assistant" and msg.get("id"):
                return str(msg["id"])

        if messages and messages[-1].get("id"):
            return str(messages[-1]["id"])

        if metadata and metadata.get("message_id"):
            return str(metadata["message_id"])

        return None

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

                if response.status_code == 401:
                    return body

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

                if response.status_code == 401:
                    if __event_emitter__:
                        await __event_emitter__(
                            {
                                "type": "status",
                                "data": {
                                    "description": self.get_text("api_key_invalid"),
                                    "done": True,
                                },
                            }
                        )
                    return body

                response.raise_for_status()
                result = response.json()

                input_tokens = result.get("inputTokens", 0)
                output_tokens = result.get("outputTokens", 0)
                total_cost = result.get("totalCost", 0)
                new_balance = result.get("newBalance", 0)

                message_id = self._resolve_message_id(body, __metadata__)

                if message_id:
                    stats_data = {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "total_cost": total_cost,
                        "new_balance": new_balance,
                    }

                    start_time = None
                    if __metadata__ is not None:
                        start_time = __metadata__.get("_usage_monitor_start_time")

                    if start_time is not None:
                        elapsed_time = time.monotonic() - start_time
                        stats_data["elapsed_time"] = elapsed_time
                        stats_data["tokens_per_sec"] = (
                            output_tokens / elapsed_time if elapsed_time > 0 else 0
                        )

                    data_dir = os.getenv("DATA_DIR", "/app/backend/data")
                    directory_path = os.path.join(data_dir, "record")
                    os.makedirs(directory_path, exist_ok=True)

                    file_path = os.path.join(directory_path, f"{message_id}.json")
                    with open(file_path, "w", encoding="utf-8") as f:
                        json.dump(stats_data, f, indent=4)
                elif __event_emitter__:
                    await __event_emitter__(
                        {
                            "type": "status",
                            "data": {
                                "description": self.get_text("unable_to_get_message_id"),
                                "done": True,
                            },
                        }
                    )

                return body
            except Exception as err:
                logger.exception(self.get_text("request_failed", error_msg=str(err)))
                if __event_emitter__:
                    await __event_emitter__(
                        {
                            "type": "status",
                            "data": {
                                "description": self.get_text("request_failed", error_msg=str(err)),
                                "done": True,
                            },
                        }
                    )
                raise Exception(self.get_text("request_failed", error_msg=str(err))) from err
