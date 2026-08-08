import type { CommandHandlers } from "../sync.js";
import { extraWorkCommandHandler } from "./extra-work.js";
import { recordPaymentHandler } from "./payment.js";
import { settlementCommandHandler } from "./settlement.js";
import { submitWeeklyReportHandler } from "./time-entry.js";
import { agreementCommandHandler, vacationCommandHandler } from "./vacation.js";

/**
 * Mapa de handlers del expediente laboral y pago (oleada 2) listo para
 * enchufarse a la ruta de sync: `processSyncBatch(pool, principal, commands,
 * { ...employmentCommandHandlers, expense: submitExpenseHandler })`.
 */
export const employmentCommandHandlers: CommandHandlers = {
  time_entry: submitWeeklyReportHandler,
  extra_work: extraWorkCommandHandler,
  settlement: settlementCommandHandler,
  payment: recordPaymentHandler,
  leave_request: vacationCommandHandler,
  agreement: agreementCommandHandler,
};
