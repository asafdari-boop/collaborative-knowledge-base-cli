export function renderAllNotesBase(): string {
  return `filters:
  and:
    - file.inFolder("Notes")
views:
  - type: table
    name: All Notes
    order:
      - file.name
      - folder
      - modifiedAt
      - primaryMoc
      - secondaryMocs
      - syncStatus
`;
}
