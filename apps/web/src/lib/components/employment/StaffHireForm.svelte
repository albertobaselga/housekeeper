<script lang="ts">
  /**
   * El alta de una persona nueva, compartida entre Personal y la pestaña
   * Contrato: el mismo formulario, la misma action `?/hire` en cada ruta y el
   * mismo `hireHouseholdMember()` detrás. Extraído a componente para que un
   * día no se cambie en una pantalla y no en la otra.
   */
  let {
    householdId,
    hired = null,
    hireError = null,
    draft = null,
    enElAcuerdo = false
  }: {
    householdId: string;
    hired: { name: string; username: string; password: string; withAgreement: boolean } | null;
    hireError: string | null;
    draft: { displayName?: string; username?: string; email?: string } | null;
    /** En la propia pantalla del acuerdo, la nota no puede mandar «a otra parte». */
    enElAcuerdo?: boolean;
  } = $props();
</script>

<section class="card" aria-labelledby="hire-title">
  <div class="section-heading">
    <div>
      <p class="eyebrow">Dar de alta</p>
      <h2 id="hire-title">Entra alguien nuevo en la casa</h2>
    </div>
  </div>

  {#if hired}
    <div class="handout" role="status">
      <p>
        <strong>{hired.name} ya puede entrar.</strong>
        {#if hired.withAgreement}Su contrato queda registrado con estas condiciones.{/if}
      </p>
      <p>Dile estos dos datos <strong>en persona</strong>:</p>
      <dl class="handout-secret">
        <div><dt>Usuario</dt><dd>{hired.username}</dd></div>
        <div><dt>Contraseña</dt><dd>{hired.password}</dd></div>
      </dl>
      <p class="audit-note">
        Esta contraseña <strong>no vuelve a mostrarse</strong> y no se guarda en ninguna parte. Al entrar,
        la aplicación le pedirá que la cambie por una suya antes de dejarla ir a ninguna otra pantalla.
        Si se pierde antes de dársela, ponle otra desde
        <a href={`/h/${householdId}/settings`}>Ajustes del hogar</a>.
      </p>
    </div>
  {/if}

  {#if hireError}
    <p class="form-error" role="alert">{hireError}</p>
  {/if}

  <!--
    Formulario liso: sin `use:enhance`, sin secciones que se abren y se
    cierran y sin nada que dependa de JavaScript. Dos razones, y las dos
    cuentan: dar de alta a una persona tiene que poder hacerse con el
    navegador que haya delante, y el trozo de `$app/forms` que arrastra la
    mejora progresiva reordenaba los trozos compartidos y le costaba 122
    bytes al arranque de Hoy, que va justo de presupuesto. Al enviar, la
    página se recarga entera y el listado ya trae a la persona nueva, que es
    exactamente lo que se quiere ver después de un alta.
  -->
  <form class="action-form" method="POST" action="?/hire">
    <label for="hire-name">Nombre visible
      <input id="hire-name" name="displayName" type="text" value={draft?.displayName ?? ''} autocomplete="off" required />
    </label>
    <label for="hire-username">Nombre de usuario (con esto entra)
      <input id="hire-username" name="username" type="text" value={draft?.username ?? ''} autocomplete="off" pattern="[a-zA-Z0-9_.]&#123;3,30&#125;" required />
    </label>
    <label for="hire-email">Correo
      <input id="hire-email" name="email" type="email" value={draft?.email ?? ''} autocomplete="off" required />
    </label>
    <p class="audit-note">
      El correo solo identifica la cuenta: <strong>a nadie se le escribe nunca</strong>. Si esta persona no
      tiene, vale algo como <code>nombre@casa.local</code>.
    </p>
    <!--
      Este desplegable es el único campo que no recuerda lo tecleado
      cuando el alta se rechaza. Marcar la opción elegida obliga a Svelte
      a traer una primitiva que no usa ninguna otra pantalla, y esa
      primitiva vive en el trozo compartido que Hoy carga al arrancar:
      costaba 110 de los 34 bytes que quedan de presupuesto. Volver a
      elegir entre dos opciones es más barato que eso.
    -->
    <label for="hire-role">Qué es en la casa
      <select id="hire-role" name="role" required>
        <option value="employee_live_in">Empleada interna</option>
        <option value="helper">Apoyo del hogar</option>
      </select>
    </label>

    <label class="inline-check">
      <input type="checkbox" name="withAgreement" checked />
      Registrar ahora su contrato
    </label>
    <p class="audit-note">
      Sin esta casilla se crea solo el acceso, y sus condiciones se pactan cuando toque. Los campos de
      abajo se ignoran si la dejas sin marcar.
    </p>

    <label for="hire-starts">Empieza el
      <input id="hire-starts" name="startsOn" type="date" />
    </label>
    <label for="hire-salary">Salario mensual (€)
      <input id="hire-salary" name="monthlySalary" type="text" inputmode="decimal" placeholder="1.400,00" />
    </label>
    <label for="hire-minutes">Jornada semanal (minutos)
      <input id="hire-minutes" name="contractedWeeklyMinutes" type="number" min="1" max="10080" value="2400" />
    </label>
    <label for="hire-vacation">Días de vacaciones al año
      <input id="hire-vacation" name="annualVacationDays" type="number" min="0" max="365" value="30" />
    </label>
    <label for="hire-reason">Por qué se pacta así
      <input id="hire-reason" name="reason" type="text" value="Alta desde la aplicación" maxlength="500" />
    </label>
    {#if enElAcuerdo}
      <p class="audit-note">
        El trabajo extra y los complementos se pactan luego aquí mismo, apilando una versión
        sobre el contrato recién creado: lo pactado no se reescribe nunca.
      </p>
    {:else}
      <p class="audit-note">
        El trabajo extra y los complementos se pactan luego en
        <a href={`/h/${householdId}/employment/acuerdo`}>El acuerdo</a>, apilando una versión: lo
        pactado no se reescribe nunca.
      </p>
    {/if}

    <div class="menu-slot-actions">
      <button class="button primary" type="submit">Crear la cuenta</button>
    </div>
  </form>
</section>

<style>
  /* La contraseña se dicta en voz alta: grande, monoespaciada y seleccionable. */
  .handout {
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    display: grid;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
    padding: var(--space-4);
  }

  .handout-secret {
    display: grid;
    gap: var(--space-2);
    margin: 0;
  }

  .handout-secret div {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .handout-secret dt {
    color: var(--ink-soft);
    font-size: var(--text-micro);
    min-width: 6rem;
  }

  .handout-secret dd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--text-title);
    letter-spacing: 0.04em;
    margin: 0;
    user-select: all;
  }

  .inline-check {
    align-items: center;
    display: flex;
    gap: var(--space-2);
  }
</style>
