export default defineMcpTool({
  name: 'crm_fields',
  description: 'Поля сущности CRM: код (как в crm_item_*), название, тип, обязательное, только чтение, справочник (statusType — значения в crm_stages/настройках). Чтобы понять, что за поле ufCrm…, и что можно менять.',
  annotations: READ_ONLY,
  inputSchema: { entity: crmEntity },
  handler: async ({ entity }) => {
    const { result } = await b24Call('crm_fields', 'crm.item.fields', { entityTypeId: entityTypeId(entity) }, { entity })
    return Object.entries(result?.fields ?? {}).map(([code, f]: [string, any]) => ({
      code,
      title: f.title,
      type: f.type,
      ...(f.isRequired ? { required: true } : {}),
      ...(f.isReadOnly ? { readOnly: true } : {}),
      ...(f.isMultiple ? { multiple: true } : {}),
      ...(f.statusType ? { statusType: f.statusType } : {}),
      ...(Array.isArray(f.items) ? { items: f.items.map((i: any) => ({ id: i.ID ?? i.id, value: i.VALUE ?? i.value })) } : {}),
    }))
  },
})
