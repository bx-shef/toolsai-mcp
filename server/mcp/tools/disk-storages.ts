// disk.storage.getlist — .bitrix-docs/b24-rest-docs/api-reference/disk/storage/; замер 2026-10-17
export default defineMcpTool({
  name: 'disk_storages',
  description: 'Хранилища Диска, доступные сотруднику: свой диск, общий диск, диски групп — с ID корневой папки для disk_folder.',
  annotations: READ_ONLY,
  inputSchema: {},
  handler: async () => ((await b24Call('disk_storages', 'disk.storage.getlist', {})).result ?? [])
    .map((s: any) => ({ id: Number(s.ID), name: s.NAME, type: s.ENTITY_TYPE, rootFolderId: Number(s.ROOT_OBJECT_ID) })),
})
