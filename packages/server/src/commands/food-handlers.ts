import type { CommandHandlers } from "../sync.js";
import { dinerCommandHandler, foodCommandHandler, recipeCommandHandler } from "./food.js";
import {
  menuGroupCommandHandler,
  menuSlotCommandHandler,
  shoppingItemCommandHandler,
} from "./menu.js";
import { menuTemplateCommandHandler } from "./menu-template.js";

export * from "./food.js";
export * from "./menu.js";
export * from "./menu-template.js";

/**
 * Handlers de comida, menú y compra listos para `processSyncBatch`: catálogo
 * (food, diner), recetas, grupos y huecos del menú semanal, plantillas de
 * semana y añadidos de la lista de la compra.
 */
export const foodCommandHandlers: CommandHandlers = {
  food: foodCommandHandler,
  diner: dinerCommandHandler,
  recipe: recipeCommandHandler,
  menu_group: menuGroupCommandHandler,
  menu_slot: menuSlotCommandHandler,
  menu_template: menuTemplateCommandHandler,
  shopping_item: shoppingItemCommandHandler,
};
