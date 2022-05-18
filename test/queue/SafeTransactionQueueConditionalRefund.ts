import { BigNumber } from 'ethers'
import { AddressZero } from '@ethersproject/constants'
import { expect } from 'chai'
import hre, { deployments, waffle } from 'hardhat'
import '@nomiclabs/hardhat-ethers'
import { deployContract, getTestSafe, getTransactionQueueInstance } from '../utils/setup'
import {
  buildSignatureBytes,
  calculateSafeTransactionHash,
  buildSafeTransaction,
  buildContractCall,
  calculateRelayMessageHash,
  executeTx,
  signHash,
  signRelayMessageTypedData,
  executeTxWithSignersAndRefund,
  buildRelayMessage,
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

    return {
      safe,
      transactionQueueInstance,
      storageSetter,
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

  describe('getRelayMessageHash', () => {
    it('should correctly calculate EIP-712 hash of the relay message', async () => {
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
      const relayMessageHash = await transactionQueueInstance.getRelayMessageHash(
        transactionHash,
        AddressZero,
        1000000,
        1000000,
        user1.address,
      )

      expect(relayMessageHash).to.eq(
        calculateRelayMessageHash(
          transactionQueueInstance,
          { safeTxHash: transactionHash, gasToken: AddressZero, maxFeePerGas: 1000000, gasLimit: 1000000, refundReceiver: user1.address },
          await chainId(),
        ),
      )
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
      const relayMessage = buildRelayMessage(txHash, AddressZero, 500000, 10000000000, user1.address)
      const relayMsgSignature = await signRelayMessageTypedData(user1, transactionQueueInstance, relayMessage)

      await expect(
        executeTxWithRefund(transactionQueueInstance, safeTransaction, [emptyTxSig], relayMessage, relayMsgSignature),
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
      const relayMessage = buildRelayMessage(txHash, AddressZero, 500000, 10000000000, user1.address)
      const relayMsgSignature = await signRelayMessageTypedData(user1, transactionQueueInstance, relayMessage)

      await expect(
        executeTxWithRefund(transactionQueueInstance, safeTransaction, [differentTxSig], relayMessage, relayMsgSignature),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it("should revert if the transaction nonce doesn't match current safe nonce", async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '1')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const relayMessage = buildRelayMessage(txHash, AddressZero, 500000, 10000000000, user1.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], relayMessage, user1),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it('should revert if relay message signature has different transaction hash', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      await user1.sendTransaction({ to: safe.address, value: parseEther('1.5') })

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const relayMessage = buildRelayMessage(`0x${'0'.repeat(64)}`, AddressZero, 500000, 10000000000, user1.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], relayMessage, user1),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it('should revert if relay message signature is not present', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      const safeTransaction = buildSafeTransaction(safe.address, user1.address, '1000000000000000000', '0x', 0, '0')
      const txHash = calculateSafeTransactionHash(transactionQueueInstance, safeTransaction, await chainId())
      const differentTxSig = await queueSignTypedData(user1, transactionQueueInstance, safeTransaction)
      const relayMessage = buildRelayMessage(txHash, AddressZero, 500000, 10000000000, user1.address)
      const relayMsgSignature = {
        signer: user1.address,
        data: '0x',
      }

      await expect(
        executeTxWithRefund(transactionQueueInstance, safeTransaction, [differentTxSig], relayMessage, relayMsgSignature),
      ).to.be.revertedWith('GnosisSafeMock: Invalid signature')
    })

    it('should revert if supplied gas is less than signed gas limit', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(0)
      await user1.sendTransaction({ to: safe.address, value: parseEther('1.5') })

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRelayCondition',
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
      const relayMessage = buildRelayMessage(txHash, AddressZero, 500000, 10000000000, user1.address)

      await expect(
        executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], relayMessage, user1, { gasLimit: 300000 }),
      ).to.be.revertedWith('NotEnoughGas')
    })

    it('should increase the nonce', async () => {
      const { safe, transactionQueueInstance } = await setupTests()

      expect(await transactionQueueInstance.safeNonces(safe.address)).to.eq(0)
      await user1.sendTransaction({ to: safe.address, value: parseEther('1.5') })

      await executeContractCallWithSigners(
        transactionQueueInstance,
        transactionQueueInstance,
        'setRelayCondition',
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
      const relayMessage = buildRelayMessage(txHash, AddressZero, 500000, 10000000000, user1.address)

      await executeTxWithSignersAndRefund(transactionQueueInstance, safeTransaction, [user1], relayMessage, user1)

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
        'setRelayCondition',
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
      const relayMessage = buildRelayMessage(txHash, AddressZero, 120000, 10000000000, user2.address)

      const userBalanceBeforeTransfer = await provider.getBalance(user1.address)
      const queueConnectedToUser2 = await transactionQueueInstance.connect(user2)
      await executeTxWithSignersAndRefund(queueConnectedToUser2, safeTransaction, [user1], relayMessage, user1)
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
        'setRelayCondition',
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

      const relayMessage = buildRelayMessage('', AddressZero, 150000, 10000000000, user2.address)
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
        relayMessage,
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
        'setRelayCondition',
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

      const relayMessage = buildRelayMessage('', AddressZero, 150000, 10000000000, user2.address)
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
        relayMessage,
        user1,
      )
      const num = 73
      const hex73 = num.toString(16)
      expect(await provider.getStorageAt(safe.address, '0x7373737373737373737373737373737373737373737373737373737373737373')).to.eq(
        `0x${hex73.padStart(64, '0')}`,
      )
    })

    it('should send ether refund', async () => {})

    it('should fail if not enough ether to refund', async () => {})

    it('should send token refund', async () => {})

    it('should send the refund if the internal transaction reverted', async () => {})

    it('should respect the relayer allowlist', async () => {})

    it('should respect maxFeePerGas relay boundary', async () => {})

    it('should respect maxGasLimit relay boundary', async () => {})
  })
})
