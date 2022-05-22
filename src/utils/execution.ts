import { chainId } from './../../test/utils/encoding'
import { Contract, Wallet, utils, BigNumber, BigNumberish, Signer } from 'ethers'

const EIP_DOMAIN = {
  EIP712Domain: [
    { type: 'uint256', name: 'chainId' },
    { type: 'address', name: 'verifyingContract' },
  ],
}

const EIP712_SAFE_TX_TYPE = {
  // "SafeTx(address safe,address to,uint256 value,bytes data,uint8 operation,uint256 nonce)"
  SafeTx: [
    { type: 'address', name: 'safe' },
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'value' },
    { type: 'bytes', name: 'data' },
    { type: 'uint8', name: 'operation' },
    { type: 'uint256', name: 'nonce' },
  ],
}

const EIP712_REFUND_PARAMS_TYPE = {
  // "RefundParams(bytes32 safeTxHash,address gasToken,uint120 gasLimit,uint120 maxFeePerGas,address refundReceiver)"
  RefundParams: [
    { type: 'bytes32', name: 'safeTxHash' },
    { type: 'address', name: 'gasToken' },
    { type: 'uint120', name: 'gasLimit' },
    { type: 'uint120', name: 'maxFeePerGas' },
    { type: 'address', name: 'refundReceiver' },
  ],
}

interface SafeTransaction {
  safe: string
  to: string
  value: BigNumberish
  data: string
  operation: number
  nonce: string
}

interface RefundParams {
  safeTxHash: string
  gasToken: string
  gasLimit: string | number | BigNumber
  maxFeePerGas: string | number | BigNumber
  refundReceiver: string
}

interface SafeSignature {
  signer: string
  data: string
}

function calculateSafeDomainSeparator(safe: Contract, chainId: BigNumberish): string {
  return utils._TypedDataEncoder.hashDomain({ verifyingContract: safe.address, chainId })
}

function preimageSafeTransactionHash(safe: Contract, safeTx: SafeTransaction, chainId: BigNumberish): string {
  return utils._TypedDataEncoder.encode({ verifyingContract: safe.address, chainId }, EIP712_SAFE_TX_TYPE, safeTx)
}

function calculateSafeTransactionHash(transactionQueue: Contract, safeTx: SafeTransaction, chainId: BigNumberish): string {
  return utils._TypedDataEncoder.hash({ verifyingContract: transactionQueue.address, chainId }, EIP712_SAFE_TX_TYPE, safeTx)
}

function preimageRefundParamsHash(transactionQueue: Contract, refundParams: RefundParams, chainId: BigNumberish): string {
  return utils._TypedDataEncoder.encode({ verifyingContract: transactionQueue.address, chainId }, EIP712_REFUND_PARAMS_TYPE, refundParams)
}

function calculateRefundParamsHash(transactionQueue: Contract, refundParams: RefundParams, chainId: BigNumberish): string {
  return utils._TypedDataEncoder.hash({ verifyingContract: transactionQueue.address, chainId }, EIP712_REFUND_PARAMS_TYPE, refundParams)
}

async function queueSignTypedData(
  signer: Wallet,
  transactionQueue: Contract,
  safeTx: SafeTransaction,
  chainId?: BigNumberish,
): Promise<SafeSignature> {
  if (!chainId && !signer.provider) throw Error('Provider required to retrieve chainId')
  const cid = chainId || (await signer.provider!!.getNetwork()).chainId
  const signerAddress = await signer.getAddress()
  return {
    signer: signerAddress,
    data: await signer._signTypedData({ verifyingContract: transactionQueue.address, chainId: cid }, EIP712_SAFE_TX_TYPE, safeTx),
  }
}

async function signHash(signer: Signer, hash: string): Promise<SafeSignature> {
  const uint8hash = utils.arrayify(hash)
  const signerAddress = await signer.getAddress()
  const sig = await signer.signMessage(uint8hash)
  const v = parseInt(sig.slice(-2), 16) + 4
  const signatureWithAdjustedV = `${sig.slice(0, -2)}${v.toString(16)}`

  return {
    signer: signerAddress,
    data: signatureWithAdjustedV,
  }
}

async function queueSignMessage(signer: Signer, safe: Contract, safeTx: SafeTransaction, chainId?: BigNumberish): Promise<SafeSignature> {
  const cid = chainId || (await signer.provider!!.getNetwork()).chainId
  return signHash(signer, calculateSafeTransactionHash(safe, safeTx, cid))
}

function buildSignatureBytes(signatures: SafeSignature[]): string {
  signatures.sort((left, right) => left.signer.toLowerCase().localeCompare(right.signer.toLowerCase()))
  let signatureBytes = '0x'
  for (const sig of signatures) {
    signatureBytes += sig.data.slice(2)
  }
  return signatureBytes
}

async function signRefundParamsHash(
  signer: Wallet,
  transactionQueue: Contract,
  refundParams: RefundParams,
  chainId?: BigNumberish,
): Promise<SafeSignature> {
  const cid = chainId || (await signer.provider!!.getNetwork()).chainId
  return signHash(signer, calculateRefundParamsHash(transactionQueue, refundParams, cid))
}

async function signRefundParamsTypedData(
  signer: Wallet,
  transactionQueue: Contract,
  refundParams: RefundParams,
  chainId?: BigNumberish,
): Promise<SafeSignature> {
  const cid = chainId || (await signer.provider!!.getNetwork()).chainId
  const signerAddress = await signer.getAddress()
  return {
    signer: signerAddress,
    data: await signer._signTypedData(
      { verifyingContract: transactionQueue.address, chainId: cid },
      EIP712_REFUND_PARAMS_TYPE,
      refundParams,
    ),
  }
}

async function logGas(message: string, tx: Promise<any>, skip?: boolean): Promise<any> {
  return tx.then(async (result) => {
    const receipt = await result.wait()
    if (!skip) console.log('           Used', receipt.gasUsed.toNumber(), `gas for >${message}<`)
    return result
  })
}

function buildRefundParams(
  safeTxHash: string,
  gasToken: string,
  gasLimit: string | number | BigNumber,
  maxFeePerGas: string | number | BigNumber,
  refundReceiver: string,
): RefundParams {
  return {
    safeTxHash,
    gasToken,
    gasLimit,
    maxFeePerGas,
    refundReceiver,
  }
}

function buildSafeTransaction(
  safe: string,
  to: string,
  value: BigNumberish,
  data: string,
  operation: number,
  nonce: string,
): SafeTransaction {
  return {
    safe,
    to,
    value,
    data,
    operation,
    nonce,
  }
}

async function executeTx(transactionQueue: Contract, safeTx: SafeTransaction, signatures: SafeSignature[], overrides?: any): Promise<any> {
  const signatureBytes = buildSignatureBytes(signatures)
  return transactionQueue.execTransaction(
    {
      safe: safeTx.safe,
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
    },
    signatureBytes,
    overrides || {},
  )
}

async function executeTxWithRefund(
  transactionQueue: Contract,
  safeTx: SafeTransaction,
  txSignatures: SafeSignature[],
  refundParams: RefundParams,
  refundSignature: SafeSignature,
  overrides?: any,
): Promise<any> {
  const signatureBytes = buildSignatureBytes(txSignatures)
  const refundSignatureBytes = buildSignatureBytes([refundSignature])
  return transactionQueue.execTransactionWithRefund(
    {
      safe: safeTx.safe,
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
    },
    signatureBytes,
    refundParams,
    refundSignatureBytes,
    overrides || {},
  )
}

function buildContractCall(
  safeAddress: string,
  contract: Contract,
  method: string,
  params: any[],
  transactionParams: Partial<Omit<SafeTransaction, 'safe' | 'data' | 'to'>>,
): SafeTransaction {
  const data = contract.interface.encodeFunctionData(method, params)
  return buildSafeTransaction(
    safeAddress,
    contract.address,
    transactionParams.value || 0,
    data,
    transactionParams.operation || 0,
    transactionParams.nonce || '0',
  )
}

async function executeTxWithSigners(transactionQueue: Contract, tx: SafeTransaction, signers: Wallet[], overrides?: any) {
  const sigs = await Promise.all(signers.map((signer) => queueSignTypedData(signer, transactionQueue, tx)))
  return executeTx(transactionQueue, tx, sigs, overrides)
}

async function executeTxWithSignersAndRefund(
  transactionQueue: Contract,
  tx: SafeTransaction,
  signers: Wallet[],
  refundParams: RefundParams,
  refundSigner: Wallet,
  overrides?: any,
) {
  const txSigs = await Promise.all(signers.map((signer) => queueSignTypedData(signer, transactionQueue, tx)))
  const refundParamsSignature = await signRefundParamsTypedData(refundSigner, transactionQueue, refundParams)

  return executeTxWithRefund(transactionQueue, tx, txSigs, refundParams, refundParamsSignature, overrides)
}

async function executeContractCallWithSigners(
  transactionQueue: Contract,
  contract: Contract,
  method: string,
  params: any[],
  signers: Wallet[],
  transactionParams: Omit<SafeTransaction, 'data' | 'to'>,
  refundParams?: Omit<RefundParams, 'safeTxHash'>,
  refundSigner?: Wallet,
) {
  const tx = buildContractCall(transactionParams.safe, contract, method, params, transactionParams)

  if (typeof refundParams === 'undefined' || typeof refundSigner === 'undefined') {
    return executeTxWithSigners(transactionQueue, tx, signers)
  }

  const refundParamsWithSafeTxHash = { ...refundParams, safeTxHash: calculateSafeTransactionHash(transactionQueue, tx, await chainId()) }

  return executeTxWithSignersAndRefund(transactionQueue, tx, signers, refundParamsWithSafeTxHash, refundSigner)
}

export {
  RefundParams,
  SafeTransaction,
  SafeSignature,
  EIP_DOMAIN,
  EIP712_SAFE_TX_TYPE,
  EIP712_REFUND_PARAMS_TYPE,
  calculateSafeDomainSeparator,
  preimageSafeTransactionHash,
  calculateSafeTransactionHash,
  preimageRefundParamsHash,
  calculateRefundParamsHash,
  buildSafeTransaction,
  buildRefundParams,
  queueSignTypedData,
  signHash,
  queueSignMessage,
  buildSignatureBytes,
  signRefundParamsHash,
  signRefundParamsTypedData,
  logGas,
  executeTx,
  buildContractCall,
  executeTxWithRefund,
  executeTxWithSignersAndRefund,
  executeTxWithSigners,
  executeContractCallWithSigners,
}
