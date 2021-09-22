// We allow some additional attached properties for Errors
interface NftError {
  code?: string | number
  message?: string
}

export default function isError(err: unknown): err is NftError {
  return (
    typeof err === 'object' && err !== null && ('code' in err || 'message' in err)
  )
}
