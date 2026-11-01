"""
title: Usage Monitor (Invisible)
author: fl0w1nd & VariantConst
git_url: https://github.com/VariantConst/OpenWebUI-Monitor.git
version: 0.3.7
required_open_webui_version: 0.12.5
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

TRANSLATIONS = {
    "en": {
        "request_failed": "Request failed: {error_msg}",
        "insufficient_balance": "Insufficient balance: Current balance `{balance:.4f}`",
        "api_key_invalid": "API key verification failed",
        "unable_to_get_message_id": "Unable to identify message ID",
    },
    "zh": {
        "request_failed": "请求失败: {error_msg}",
        "insufficient_balance": "余额不足: 当前余额 `{balance:.4f}`",
        "api_key_invalid": "API密钥验证失败",
        "unable_to_get_message_id": "无法获取消息ID",
    },
    "es": {
        "request_failed": "Solicitud fallida: {error_msg}",
        "insufficient_balance": "Saldo insuficiente: Saldo actual `{balance:.4f}`",
        "api_key_invalid": "Error de autenticación de clave API",
        "unable_to_get_message_id": "No se puede obtener el ID del mensaje",
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
        API_ENDPOINT: str = Field(
            default="", description="The base URL for the API endpoint."
        )
        API_KEY: str = Field(default="", description="API key for authentication.")
        priority: int = Field(
            default=5, description="Priority level for the filter operations."
        )
        language: str = Field(
            default="zh", description="Language for error messages (en/zh/es)."
        )

    def __init__(self):
        self.type = "filter"
        self.name = "OpenWebUI Monitor"
        self.valves = self.Valves()

    def get_text(self, key: str, **kwargs) -> str:
        lang = self.valves.language if self.valves.language in TRANSLATIONS else "en"
        text = TRANSLATIONS[lang].get(key, TRANSLATIONS["en"][key])
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

    async def _post_monitor(self, endpoint: str, payload: dict) -> dict:
        serialized_payload = json.loads(
            json.dumps(payload, default=_serialize_for_json)
        )
        async with AsyncClient(timeout=Timeout(30.0)) as client:
            response = await client.post(
                url=f"{self.valves.API_ENDPOINT}{endpoint}",
                headers={"Authorization": f"Bearer {self.valves.API_KEY}"},
                json=serialized_payload,
            )

            if response.status_code == 401:
                return {"unauthorized": True}

            response.raise_for_status()
            data = response.json()
            if not data.get("success"):
                error_msg = data.get("error", "Unknown error")
                error_type = data.get("error_type", "UNKNOWN_ERROR")
                raise CustomException(f"[{error_type}] {error_msg}")
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

            if response_data.get("unauthorized"):
                return body

            is_outage = response_data.get("balance", 0) <= 0
            if __metadata__ is not None:
                __metadata__["_usage_monitor_outage"] = is_outage

            if is_outage:
                current_balance = response_data.get("balance", 0)
                raise CustomException(
                    self.get_text("insufficient_balance", balance=current_balance)
                )

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
            result = await self._post_monitor(
                endpoint="/api/v1/outlet",
                payload={"user": user_dict, "body": body},
            )

            if result.get("unauthorized"):
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
            logger.exception(self.get_text("request_failed", error_msg=err))
            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {
                            "description": self.get_text("request_failed", error_msg=err),
                            "done": True,
                        },
                    }
                )
            raise Exception(self.get_text("request_failed", error_msg=err)) from err
