<script lang="ts">
  import PageHeader from '$lib/components/PageHeader.svelte';
  import { useAppContext } from '$lib/auth/context';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const context = useAppContext();
  const canClose = context.capabilities.includes('settlement.close');
  const canRegisterPayment = context.capabilities.includes('payment.register');
</script>

<svelte:head><title>Acuerdos y pagos · Casa Clara</title></svelte:head>

<div class="page-wrap">
  {#snippet actions()}
    {#if canClose}<button class="button primary" type="button">Revisar y cerrar</button>{/if}
  {/snippet}
  <PageHeader eyebrow="Expediente laboral" title="Acuerdos y pagos" description="Importes trazables, confirmaciones separadas y un historial claro." {actions} />

  <section class="summary-strip" aria-label="Resumen de liquidación">
    <div><span>Periodo</span><strong>{data.employment.period}</strong></div>
    <div><span>Total salarial</span><strong>{data.employment.salaryTotal}</strong></div>
    <div><span>Reembolsos</span><strong>{data.employment.reimbursementTotal}</strong></div>
    <div class="total"><span>Total transferencia</span><strong>{data.employment.transferTotal}</strong></div>
  </section>

  <div class="content-grid employment-grid">
    <article class="card ledger-card">
      <div class="section-heading"><div><p class="eyebrow">Liquidación</p><h2>Detalle de {data.employment.period.toLocaleLowerCase('es')}</h2></div><span class="status-chip warning">{data.employment.status}</span></div>
      <div class="ledger-list">
        {#each data.employment.lines as line}
          <div><span><strong>{line.concept}</strong><small>{line.detail}</small></span><strong>{line.amount}</strong></div>
        {/each}
      </div>
      <div class="ledger-total"><span>Total a transferir</span><strong>{data.employment.transferTotal}</strong></div>
      <p class="audit-note">Cada línea conserva su origen y la regla vigente al cerrar el periodo.</p>
    </article>

    <aside class="stack">
      <article class="card">
        <p class="eyebrow">Saldos</p><h2>Tiempo y compensación</h2>
        <div class="balance-list">
          {#each data.employment.balance as item}
            <div><span><strong>{item.label}</strong><small>{item.detail}</small></span><strong>{item.value}</strong></div>
          {/each}
        </div>
      </article>
      <article class="card quiet-card">
        <span class="card-icon" aria-hidden="true">✓</span>
        <h2>Confirmación independiente</h2>
        <p>Registrar una transferencia no confirma por sí solo que la otra parte la haya recibido.</p>
        {#if canRegisterPayment}<button class="button secondary full" type="button">Registrar pago</button>{/if}
      </article>
    </aside>
  </div>
</div>
