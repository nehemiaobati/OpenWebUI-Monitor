"""
title: Usage Info Button / 计费信息按钮
author: fl0w1nd
author_url: https://github.com/fl0w1nd
version: 0.1.3
required_open_webui_version: 0.12.5
icon_url: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAACMElEQVR4nO2ZMWgUQRSGJ4mFgZBGQTAgCqawSbASg6YIFkEsPbCQHNzd/v/sHBe4IvUSUtqlThcCSZEiXUharWxURC20SDCQIGKMxjTBk4E7MhlO7naX3M7C/PCamZud9817M/NuVwgvLy8vZ0VylOQ6ySOSjR7bEYA1kiNpnP+egeMNy74lgmiufMMRW00CkEXaNP5jh0kAzj1E9FhMO78HSCn6CDBeDsbdmM5FgB7gvHwEmPE9kFoeIGvRp1B6AXgOAEqpoVxGAMCenhvAjdiDPUAKlcvlayQJ4FczArO1Wm04FxEAUCV53O6vJYBppwGklKUONdWJlPKukwBRFF0iuW/NuwLgpdkGYMtJAAD3rTnXW2AAvhjtp9Vq9YqLAAVrpecMXxatvknnAEg+tZycb/VJKZ+R3G4ZgAfOAYRhOGYBHJC8mfiBGZxCfSQ/WhBfpZRPEj0to2P0Ybs7AMCmUup2Li6yIAgmrFOnBfFH74Vc1ELFYvGyPoWaL3ZNP05JPs5TMXcVwIYViU96v3Qz+GfcVyVxLE40SL43x4ZheKcbgLVeApD8bazyG6tvwRrfOY30R4U2OXiRAJ+N/h9RFPUbi/nCHBsEwSPRjUql0nX9ceEi0qkNwLL1mxndXq/XBwF8MPsqlcot4ZqklFMWwF+SrwDsWu2vhasCsNQhcicA7glXVSgUBnQRZ25oY2O/1SW3yIOUUkMAKk3nd0iOi7wpPKtO32XtSyJ1C/APUWkkXC3hgzUAAAAASUVORK5CYII=
"""

import json
import os
from typing import Any, Callable, Dict, Optional
from pydantic import BaseModel, Field


class Action:
    class Valves(BaseModel):
        priority: int = Field(
            default=0,
            description="Priority / 优先级 / Prioridad",
        )
        show_cost: bool = Field(
            default=True,
            description="Show cost / 是否显示费用 / Mostrar costo",
            json_schema_extra={
                "ui:group": "Display Settings / 显示设置 / Configuración de Visualización"
            },
        )
        show_balance: bool = Field(
            default=True,
            description="Show balance / 是否显示余额 / Mostrar saldo",
            json_schema_extra={
                "ui:group": "Display Settings / 显示设置 / Configuración de Visualización"
            },
        )
        show_tokens: bool = Field(
            default=True,
            description="Show tokens / 是否显示token数 / Mostrar tokens",
            json_schema_extra={
                "ui:group": "Display Settings / 显示设置 / Configuración de Visualización"
            },
        )
        show_tokens_per_sec: bool = Field(
            default=True,
            description="Show tokens per second / 是否显示每秒输出token数 / Mostrar tokens por segundo",
            json_schema_extra={
                "ui:group": "Display Settings / 显示设置 / Configuración de Visualización"
            },
        )

    def __init__(self):
        self.valves = self.Valves()

    def _resolve_message_id(
        self, body: Dict[str, Any], metadata: Optional[Dict[str, Any]] = None
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

    def _build_stats_display(self, stats_data: Dict[str, Any]) -> str:
        stats_array = []

        if self.valves.show_cost and "total_cost" in stats_data:
            stats_array.append(f"Cost: ${stats_data['total_cost']:.6f}")
        if self.valves.show_balance and "new_balance" in stats_data:
            stats_array.append(f"Balance: ${stats_data['new_balance']:.6f}")
        if (
            self.valves.show_tokens
            and "input_tokens" in stats_data
            and "output_tokens" in stats_data
        ):
            stats_array.append(
                f"Token: {stats_data['input_tokens']}+{stats_data['output_tokens']}"
            )

        elapsed_time = stats_data.get("elapsed_time")
        if elapsed_time is not None:
            stats_array.append(f"Time: {elapsed_time:.2f}s")
            output_tokens = stats_data.get("output_tokens", 0)
            if self.valves.show_tokens_per_sec and elapsed_time > 0:
                stats_array.append(f"{(output_tokens / elapsed_time):.2f} T/s")

        return " | ".join(stats_array)

    async def _emit_status(
        self,
        event_emitter: Optional[Callable[[Dict[str, Any]], Any]],
        description: str,
    ) -> None:
        if event_emitter:
            await event_emitter(
                {
                    "type": "status",
                    "data": {
                        "description": description,
                        "done": True,
                    },
                }
            )

    async def action(
        self,
        body: dict,
        __metadata__: Optional[dict] = None,
        __user__: Optional[dict] = None,
        __event_emitter__: Optional[Callable] = None,
        __event_call__: Optional[Callable] = None,
    ) -> Optional[dict]:
        message_id = self._resolve_message_id(body, __metadata__)
        if not message_id:
            await self._emit_status(
                __event_emitter__,
                "Unable to identify message / 无法获取消息ID / No se puede identificar el mensaje",
            )
            return None

        data_dir = os.getenv("DATA_DIR", "/app/backend/data")
        file_path = os.path.join(data_dir, "record", f"{message_id}.json")

        if not os.path.exists(file_path):
            await self._emit_status(
                __event_emitter__,
                "Billing record not found, please contact admin / 未查找到该消息的计费记录，请联系管理员 / Registro de facturación no encontrado, contacte al administrador",
            )
            return None

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                stats_data = json.load(f)
        except Exception as err:
            await self._emit_status(
                __event_emitter__,
                f"Failed to read stats / 读取统计失败 / Error al leer estadísticas: {err}",
            )
            return None

        display_text = self._build_stats_display(stats_data)
        await self._emit_status(__event_emitter__, display_text)
        return None
