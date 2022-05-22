import { BigNumber } from 'ethers'
import { AddressZero } from '@ethersproject/constants'
import { expect } from 'chai'
import hre, { deployments, waffle } from 'hardhat'
import '@nomiclabs/hardhat-ethers'
import { deployContract, getTestSafe, getTransactionQueueInstance } from '../utils/setup'
import {
  calculateSafeTransactionHash,
  buildSafeTransaction,
  buildContractCall,
  calculateRefundParamsHash,
  executeTx,
  signHash,
  signRefundParamsTypedData,
  executeTxWithSignersAndRefund,
  buildRefundParams,
  executeTxWithRefund,
  executeTxWithSigners,
  executeContractCallWithSigners,
  queueSignTypedData,
} from '../../src/utils/execution'
import { parseEther } from '@ethersproject/units'
import { chainId } from '../utils/encoding'

describe('SafeTransactionQueueConditionalRefund', async () => {
  const [user1, user2] = waffle.provider.getWallets()

  const setupTests = deployments.createFixture(async ({ deployments }) => {
    await deployments.fixture()

    const transactionQueueInstance = await getTransactionQueueInstance()

    const safe = await getTestSafe(user1, transactionQueueInstance.address)

    const setterSource = `
        contract StorageSetter {
            function setStorage(uint256 numba) public {
                bytes32 slot = 0x7373737373737373737373737373737373737373737373737373737373737373;
                assembly {
                    sstore(slot, numba)
                }
            }
        }`
    const storageSetter = await deployContract(user1, setterSource)
    const revertorSource = `
        contract Revertooor {
            function setStorage(uint256 numba) public {
                require(false, "Revert me!");
            }
        }`
    const revertooor = await deployContract(user1, revertorSource)

    return {
      safe,
      transactionQueueInstance,
      storageSetter,
      revertooor,
    }
  })

  describe('getTransactionHash', () => {
    it('should correctly calculate EIP-712 hash of the transaction', async () => {
      const { safe, transactionQueueInstance, storageSetter } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const transactionHash = await transactionQueueInstance.getTransactionHash(
        safe.address,
        safeTransaction.to,
        safeTransaction.value,
        safeTransaction.data,
        safeTransaction.operation,
        safeTransaction.nonce,
      )

      const setStorageTx = buildContractCall(safe.address, storageSetter, 'setStorage', ['0xabcdad'], {
        operation: 1,
      })
      const transactionHash2 = await transactionQueueInstance.getTransactionHash(
        safe.address,
        setStorageTx.to,
        setStorageTx.value,
        setStorageTx.data,
        setStorageTx.operation,
        setStorageTx.nonce,
      )

      expect(transactionHash).to.eq(calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId()))
      expect(transactionHash2).to.eq(calculateSafeTransactionHash(transactionQueueInstance, setStorageTx, await chainId()))
    })
  })

  describe('getRefundParamsHash', () => {
    it('should correctly calculate EIP-712 hash of the refund params', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const transactionHash = await transactionQueueInstance.getTransactionHash(
        safe.address,
        safeTransaction.to,
        safeTransaction.value,
        safeTransaction.data,
        safeTransaction.nonce,
        safeTransaction.operation,
      )
      const refundParamsHash = await transactionQueueInstance.getRefundParamsHash(
        transactionHash,
        AddressZero,
        1000000,
        1000000,
        user1.address,
      )

      expect(refundParamsHash).to.eq(
        calculateRefundParamsHash(
          transactionQueueInstance,
          { safeTxHash: transactionHash, gasToken: AddressZero, maxFeePerGas: 1000000, gasLimit: 1000000, refundReceiver: user1.address },
          await chainId(),
        ),
      )
    })
  })

  describe('setRefundCondition', () => {
    it('sets refund conditions for msg.sender and token address', async () => {
      const { safe, transactionQueueInstance } = await setupTests()
      const tokenAddress = `0x${'42'.repeat(20)}`

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [tokenAddress, 10000000000, 10000000, [user2.address]],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const refundConditionToken = await transactionQueueInstance.safeRefundConditions(safe.address, tokenAddress)
      const refundConditionETH = await transactionQueueInstance.safeRefundConditions(safe.address, AddressZero)

      expect(refundConditionETH.maxFeePerGas).to.eq(0)
      expect(refundConditionETH.maxGasLimit).to.eq(0)
      expect(refundConditionETH.allowedRefundReceiversCount).to.eq(0)

      expect(refundConditionToken.maxFeePerGas).to.equal('10000000000')
      expect(refundConditionToken.maxGasLimit).to.equal('10000000')
      expect(refundConditionToken.allowedRefundReceiversCount).to.equal(1)
    })
  })

  describe('execTransaction', () => {
    it('should revert if signature data is not present', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')

      await expect(executeTx(transactionQueueInstance, safeTransaction, [{ signer: user1.address, data: '0x' }])).to.be.revertedWith(
        'GnosisSafeMock: Invalid signature',
      )
    })

    it('should revert if signatures are invalid', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')

      // The mock only supports ECDSA signatures with eth_sign/eip191
      const signature =
        '0x' +
        '000000000000000000000000' +
        user1.address.slice(2) +
        '0000000000000000000000000000000000000000000000000000000000000041' +
        '00' // r, s, v

      await expect(executeTx(transactionQueueInstance, safeTransaction, [{ signer: user1.address, data: signature }])).to.be.revertedWith(
        'GnosisSafeMock: Invalid signature',
      )
    })

    it("should revert if the signed nonce doesn't match current safe nonce", async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '1')

      const transactionHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())

      // The mock only supports ECDSA signatures with eth_sign/eip191
      const signature = await signHash(user1, transactionHash)

      await expect(executeTx(transactionQueueInstance, safeTransaction, [signature])).to.be.revertedWith(
        'GnosisSafeMock: Invalid signature',
      )
    })

    it('should increase the nonce', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(0)

      await user1.sendTransaction({ to: safe.address, value: parseEther('1') })

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, parseEther('1'), '0x', 0, '0')
      const transactionHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())

      // The mock only supports ECDSA signatures with eth_sign/eip191
      const signature = await signHash(user1, transactionHash)

      await executeTx(transactionQueueInstance, safeTransaction, [signature])

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(1)
    })

    it('should execute native token transfers', async () => {
      const { safe, transactionQueueInstance } = await setupTests()
      const provider = hre.ethers.provider

      expect(await provider.getBalance(safe.address)).to.eq(0)
      await user1.sendTransaction({ to: safe.address, value: parseEther('1') })
      expect(await provider.getBalance(safe.address)).to.eq(parseEther('1'))

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, parseEther('1'), '0x', 0, '0')
      const transactionHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())

      // The mock only supports ECDSA signatures with eth_sign/eip191
      const signature = await signHash(user1, transactionHash)

      // Connect to user2, so user1 doesnt spend gas to send the transaction and we get more accurate balance calculations
      const queueWithUser2 = transactionQueueInstance.connect(user2)
      const balanceBeforeTransfer = await provider.getBalance(user1.address)
      await executeTx(queueWithUser2, safeTransaction, [signature])
      const balanceAfterTransfer = await provider.getBalance(user1.address)

      expect(balanceAfterTransfer).to.eq(balanceBeforeTransfer.add(parseEther('1')))
    })

    it('should execute contract calls', async () => {
      const { safe, transactionQueueInstance, storageSetter } = await setupTests()
      const provider = hre.ethers.provider

      expect(
        await provider.getStorageAt(storageSetter.address, '0x7373737373737373737373737373737373737373737373737373737373737373'),
      ).to.eq(`0x${'0'.repeat(64)}`)

      const setStorageTx = buildContractCall(safe.address, storageSetter, 'setStorage', [543], {
        operation: 0,
      })

      await executeTxWithSigners(transactionQueueInstance, setStorageTx, [user1])

      const num = 543
      const hex543 = num.toString(16)
      expect(
        await provider.getStorageAt(storageSetter.address, '0x7373737373737373737373737373737373737373737373737373737373737373'),
      ).to.eq(`0x${hex543.padStart(64, '0')}`)
    })

    it('should execute delegatecall calls', async () => {
      const { safe, transactionQueueInstance, storageSetter } = await setupTests()
      const provider = hre.ethers.provider

      expect(await provider.getStorageAt(safe.address, '0x7373737373737373737373737373737373737373737373737373737373737373')).to.eq(
        `0x${'0'.repeat(64)}`,
      )

      const setStorageTx = buildContractCall(safe.address, storageSetter, 'setStorage', [543], {
        operation: 1,
      })

      const transactionHash = calculateSafeTransactionHash(transactionQueueInstance, setStorageTx, await chainId())

      // The mock only supports ECDSA signatures with eth_sign/eip191
      const signature = await signHash(user1, transactionHash)

      await executeTx(transactionQueueInstance, setStorageTx, [signature])

      const num = 543
      const hex543 = num.toString(16)
      expect(await provider.getStorageAt(safe.address, '0x7373737373737373737373737373737373737373737373737373737373737373')).to.eq(
        `0x${hex543.padStart(64, '0')}`,
      )
    })
  })

  describe('execTransactionWithRefund', () => {
    it('should revert if transaction signature data is not present', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const emptyTxSig = {
        signer: user1.address,
        data: '0x',
      }
      const refundParams = buildRefundParams(txHash, AddressZero, 500000, 10000000000, user1.address)
      const refundParamsSignature = await signRefundParamsTypedData(user1, transactionQueueInstance, refundParams)

      await expect(
        executeTxWithRefund(transactionQueueInstance, safeTransaction, [emptyTxSig], refundParams, refundParamsSignature),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it('should revert if transaction signatures are invalid', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const differentTxSig = await queueSignTypedData(
        user1,
        transactionQueueInstance,
        buildSafeTransaction(safe.address, user2.address, '2000000000000000000', '0x', 0, '0'),
      )
      const refundParams = buildRefundParams(txHash, AddressZero, 500000, 10000000000, user1.address)
      const refundParamsSignature = await signRefundParamsTypedData(user1, transactionQueueInstance, refundParams)

      await expect(
        executeTxWithRefund(transactionQueueInstance, safeTransaction, [differentTxSig], refundParams, refundParamsSignature),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it("should revert if the transaction nonce doesn't match current safe nonce", async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 500000, 10000000000, user1.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], refundParams, user1),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it('should revert if refund message signature has different transaction hash', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      await user1.sendTransaction({ to: safe.address, value: parseEther('1.5') })

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const refundParams = buildRefundParams(`0x${'0'.repeat(64)}`, AddressZero, 500000, 10000000000, user1.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], refundParams, user1),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it('should revert if refund message signature is not present', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const differentTxSig = await queueSignTypedData(user1, transactionQueueInstance, safeTransaction)
      const refundParams = buildRefundParams(txHash, AddressZero, 500000, 10000000000, user1.address)
      const refundParamsSignature = {
        signer: user1.address,
        data: '0x',
      }

      await expect(
        executeTxWithRefund(transactionQueueInstance, safeTransaction, [differentTxSig], refundParams, refundParamsSignature),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it('should revert if supplied gas is less than signed gas limit', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(0)
      await user1.sendTransaction({ to: safe.address, value: parseEther('1.5') })

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 500000, 10000000000, user1.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], refundParams, user1, { gasLimit: 300000 }),
      ).to.be.revertedWith('NotEnoughGas')
    })

    it('should increase the nonce', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(0)
      await user1.sendTransaction({ to: safe.address, value: parseEther('1.5') })

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, parseEther('1'), '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 500000, 10000000000, user1.address)

      await executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], refundParams, user1)

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(2)
    })

    it('should execute native token transfers', async () => {
      const { safe, transactionQueueInstance } = await setupTests()
      const provider = hre.ethers.provider
      const transferAmountWei = parseEther('1.5')
      const maxGasRefund = BigNumber.from('10000000000').mul('120000')

      await user1.sendTransaction({ to: safe.address, value: transferAmountWei.add(maxGasRefund) })
      expect(await provider.getBalance(safe.address)).to.eq(transferAmountWei.add(maxGasRefund))

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, transferAmountWei, '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 120000, 10000000000, user2.address)

      const userBalanceBeforeTransfer = await provider.getBalance(user1.address)
      const queueConnectedToUser2 = await transactionQueueInstance.connect(user2)
      await executeTxWithSignersAndRefund(queueConnectedToUser2, safeTransaction, [user1], refundParams, user1)
      const userBalanceAfterTransfer = await provider.getBalance(user1.address)

      expect(userBalanceAfterTransfer.sub(userBalanceBeforeTransfer)).to.eq(transferAmountWei)
    })

    it('should execute contract calls', async () => {
      const { safe, transactionQueueInstance, storageSetter } = await setupTests()
      const provider = hre.ethers.provider
      const maxGasRefund = BigNumber.from('10000000000').mul('150000')

      await user1.sendTransaction({ to: safe.address, value: maxGasRefund })

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      expect(
        await provider.getStorageAt(storageSetter.address, '0x7373737373737373737373737373737373737373737373737373737373737373'),
      ).to.eq(`0x${'0'.repeat(64)}`)

      const refundParams = buildRefundParams('', AddressZero, 150000, 10000000000, user2.address)
      const queueConnectedToUser2 = await transactionQueueInstance.connect(user2)
      await executeContractCallWithSigners(
        queueConnectedToUser2,
        storageSetter,
        'setStorage',
        [73],
        [user1],
        {
          safe: safe.address,
          nonce: '1',
          value: '0',
          operation: 0,
        },
        refundParams,
        user1,
      )
      const num = 73
      const hex73 = num.toString(16)
      expect(
        await provider.getStorageAt(storageSetter.address, '0x7373737373737373737373737373737373737373737373737373737373737373'),
      ).to.eq(`0x${hex73.padStart(64, '0')}`)
    })

    it('should execute delegate calls', async () => {
      const { safe, transactionQueueInstance, storageSetter } = await setupTests()
      const provider = hre.ethers.provider
      const maxGasRefund = BigNumber.from('10000000000').mul('150000')

      await user1.sendTransaction({ to: safe.address, value: maxGasRefund })

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      expect(
        await provider.getStorageAt(storageSetter.address, '0x7373737373737373737373737373737373737373737373737373737373737373'),
      ).to.eq(`0x${'0'.repeat(64)}`)

      const refundParams = buildRefundParams('', AddressZero, 150000, 10000000000, user2.address)
      const queueConnectedToUser2 = await transactionQueueInstance.connect(user2)
      await executeContractCallWithSigners(
        queueConnectedToUser2,
        storageSetter,
        'setStorage',
        [73],
        [user1],
        {
          safe: safe.address,
          nonce: '1',
          value: '0',
          operation: 1,
        },
        refundParams,
        user1,
      )
      const num = 73
      const hex73 = num.toString(16)
      expect(await provider.getStorageAt(safe.address, '0x7373737373737373737373737373737373737373737373737373737373737373')).to.eq(
        `0x${hex73.padStart(64, '0')}`,
      )
    })

    it('should send ether refund', async () => {
      const { safe, transactionQueueInstance } = await setupTests()
      const provider = hre.ethers.provider
      const transferAmountWei = parseEther('1.5')
      const maxGasRefund = BigNumber.from('10000000000').mul('120000')

      await user1.sendTransaction({ to: safe.address, value: transferAmountWei.add(maxGasRefund) })

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, transferAmountWei, '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 120000, 10000000000, user2.address)

      const user2BalanceBeforeTransfer = await provider.getBalance(user2.address)
      const tx = executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], refundParams, user1)
      await expect(tx).to.emit(transactionQueueInstance, 'SuccessfulExecution').withArgs
      const txReceipt = await (await tx).wait(1)
      const successEvent = transactionQueueInstance.interface.decodeEventLog(
        'SuccessfulExecution',
        txReceipt.logs[0].data,
        txReceipt.logs[0].topics,
      )
      const user2BalanceAfterTransfer = await provider.getBalance(user2.address)
      expect(user2BalanceAfterTransfer).to.be.equal(user2BalanceBeforeTransfer.add(successEvent.payment))
    })

    it('should fail if not enough ether to refund', async () => {
      const { safe, transactionQueueInstance } = await setupTests()
      const provider = hre.ethers.provider
      const transferAmountWei = parseEther('1')

      await user1.sendTransaction({ to: safe.address, value: transferAmountWei })
      expect(await provider.getBalance(safe.address)).to.eq(transferAmountWei)

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, transferAmountWei, '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 120000, 10000000000, user2.address)
      const queueConnectedToUser2 = await transactionQueueInstance.connect(user2)

      await expect(executeTxWithSignersAndRefund(queueConnectedToUser2, safeTransaction, [user1], refundParams, user1)).to.be.revertedWith(
        'RefundFailure()',
      )
    })

    it('should send token refund', async () => {})

    it('should send the refund if the internal transaction reverted', async () => {
      const { safe, transactionQueueInstance, revertooor } = await setupTests()
      const provider = hre.ethers.provider
      const maxGasRefund = BigNumber.from('10000000000').mul('150000')

      await user1.sendTransaction({ to: safe.address, value: maxGasRefund })

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const refundParams = buildRefundParams('', AddressZero, 150000, 10000000000, user2.address)

      const user2BalanceBeforeTransfer = await provider.getBalance(user2.address)
      const tx = await executeContractCallWithSigners(
        transactionQueueInstance,
        revertooor,
        'setStorage',
        [73],
        [user1],
        {
          safe: safe.address,
          nonce: '1',
          value: '0',
          operation: 0,
        },
        refundParams,
        user1,
      )
      await expect(tx).to.emit(transactionQueueInstance, 'SuccessfulExecution').withArgs
      const txReceipt = await (await tx).wait(1)
      const successEvent = transactionQueueInstance.interface.decodeEventLog(
        'SuccessfulExecution',
        txReceipt.logs[0].data,
        txReceipt.logs[0].topics,
      )
      const user2BalanceAfterTransfer = await provider.getBalance(user2.address)
      expect(user2BalanceAfterTransfer).to.be.equal(user2BalanceBeforeTransfer.add(successEvent.payment))
    })

    it('should respect the refund receiver allowlist', async () => {
      const { safe, transactionQueueInstance } = await setupTests()
      const provider = hre.ethers.provider
      const transferAmountWei = parseEther('1.5')
      const maxGasRefund = BigNumber.from('10000000000').mul('120000')

      await user1.sendTransaction({ to: safe.address, value: transferAmountWei.add(maxGasRefund) })
      expect(await provider.getBalance(safe.address)).to.eq(transferAmountWei.add(maxGasRefund))

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, [user1.address]],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, transferAmountWei, '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 120000, 10000000000, user2.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], refundParams, user1),
      ).to.be.revertedWith('InvalidRefundReceiver()')
    })

    it('should respect maxFeePerGas refund boundary', async () => {
      const { safe, transactionQueueInstance } = await setupTests()
      const provider = hre.ethers.provider
      const transferAmountWei = parseEther('1.5')
      const maxGasRefund = BigNumber.from('10000000000').mul('120000')

      await user1.sendTransaction({ to: safe.address, value: transferAmountWei.add(maxGasRefund) })
      expect(await provider.getBalance(safe.address)).to.eq(transferAmountWei.add(maxGasRefund))

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, transferAmountWei, '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 120000, 100000000000, user2.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], refundParams, user1),
      ).to.be.revertedWith('RefundGasBoundariesNotMet()')
    })

    it('should respect maxGasLimit refund boundary', async () => {
      const { safe, transactionQueueInstance } = await setupTests()
      const provider = hre.ethers.provider
      const transferAmountWei = parseEther('1.5')
      const maxGasRefund = BigNumber.from('10000000000').mul('120000')

      await user1.sendTransaction({ to: safe.address, value: transferAmountWei.add(maxGasRefund) })
      expect(await provider.getBalance(safe.address)).to.eq(transferAmountWei.add(maxGasRefund))

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRefundConditions',
        [AddressZero, 10000000000, 10000000, []],
        [user1],
        {
          safe: safe.address,
          nonce: '0',
          value: '0',
          operation: 0,
        },
      )

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, transferAmountWei, '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const refundParams = buildRefundParams(txHash, AddressZero, 10000000 + 5000000, 10000000000, user2.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], refundParams, user1),
      ).to.be.revertedWith('RefundGasBoundariesNotMet()')
    })
  })
})
